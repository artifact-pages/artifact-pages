package publisher

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

// applicationRootObjects is the complete set of application-owned files at
// the bucket root. Keep this list aligned with scripts/web-bundle-paths.mjs
// and the AWS route/IAM contract; removal never lists or deletes the bucket
// root as a whole.
var applicationRootObjects = []string{
	"index.html",
	"preview-bridge.js",
	"LICENSE",
	"THIRD_PARTY_NOTICES.txt",
}

type AppRemoveOptions struct {
	DryRun bool
}

// RemoveApp removes the application-owned bundle under the application lock.
// It only probes the four fixed root objects and lists the assets/ prefix; it
// never enumerates or mutates the content, registry, preview, or control planes
// except for a fully validated legacy application purge record and retained lock.
func RemoveApp(ctx context.Context, backend DeploymentBackend, options AppRemoveOptions) (Result, error) {
	result := Result{Operation: "app remove", Changes: []Change{}}
	if ctx == nil {
		return result, errors.New("application removal context is required")
	}
	if backend == nil {
		return result, errors.New("deployment backend is required")
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		return result, errors.New("deployment backend does not support conditional object reads and writes")
	}
	metadata, ok := backend.(ObjectMetadataBackend)
	if !ok {
		return result, errors.New("deployment backend does not support object metadata reads")
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}

	if _, _, err := readVersionRecord(ctx, conditional, appVersionsKey); err != nil {
		return result, err
	}
	operation := func() (Result, error) {
		_, appRecorded, err := readVersionRecord(ctx, conditional, appVersionsKey)
		if err != nil {
			return result, err
		}
		_, retryETag, err := readAppCacheRetry(ctx, conditional)
		if err != nil {
			return result, err
		}
		keys, err := applicationObjectKeys(ctx, backend, metadata)
		if err != nil {
			return result, err
		}
		if appRecorded {
			keys = append(keys, appVersionsKey)
		}
		plan := make([]Change, 0, len(keys))
		for _, key := range keys {
			plan = append(plan, Change{Action: "remove", Path: key})
		}
		result.Changes = plan
		result.FilesRemoved = len(keys)
		if options.DryRun {
			if len(keys) == 0 && retryETag == "" {
				result.Outcome = "no-op"
			} else {
				result.Outcome = "planned"
			}
			return result, nil
		}
		// The remaining result describes work completed by this invocation;
		// changes remains the reviewed plan. Do not report planned deletions as
		// completed when validation or journal persistence fails.
		result.FilesRemoved = 0
		if len(keys) == 0 && retryETag == "" {
			result.Outcome = "no-op"
			result.FilesRemoved = 0
			return result, nil
		}
		if retryETag != "" {
			if err := clearAppCacheRetry(ctx, backend); err != nil {
				return result, fmt.Errorf("retire validated application invalidation record: %w", err)
			}
		}
		if len(keys) > 0 {
			if err := backend.DeleteObjects(ctx, keys); err != nil {
				return result, fmt.Errorf("application objects may be partially removed; retry app remove: %w", err)
			}
			result.FilesRemoved = len(keys)
		}
		result.Outcome = "removed"
		return result, nil
	}

	if options.DryRun {
		return operation()
	}
	_, release, err := (SiteLockManager{Backend: conditional}).AcquireApplication(ctx)
	if err != nil {
		return result, err
	}
	result, operationErr := operation()
	if release != nil {
		releaseErr := release()
		if operationErr == nil && releaseErr != nil {
			operationErr = fmt.Errorf("application removal completed but lock release failed: %w", releaseErr)
		} else if operationErr != nil && releaseErr != nil {
			operationErr = errors.Join(operationErr, fmt.Errorf("release application lock: %w", releaseErr))
		}
	}
	if operationErr != nil {
		return result, operationErr
	}
	return result, nil
}

func applicationObjectKeys(ctx context.Context, backend DeploymentBackend, metadata ObjectMetadataBackend) ([]string, error) {
	keys := make([]string, 0)
	for _, key := range applicationRootObjects {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		_, err := metadata.HeadObject(ctx, key)
		if errors.Is(err, ErrObjectNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("inspect application object %s: %w", key, err)
		}
		keys = append(keys, key)
	}
	assets, err := backend.ListKeys(ctx, "assets/")
	if err != nil {
		return nil, fmt.Errorf("list application assets: %w", err)
	}
	for _, key := range assets {
		if !strings.HasPrefix(key, "assets/") || key == "assets/" {
			return nil, fmt.Errorf("application assets listing returned out-of-scope key %q", key)
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return uniqueSorted(keys), nil
}
