package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"

	"github.com/tasuku43/git-artifact-pages/internal/registry"
)

// PublishRegistry validates and deploys the Git-owned YAML registry. A real
// apply holds a registry lock and site locks for changed existing identities;
// a dry-run is read-only and returns the same sorted plan.
func PublishRegistry(ctx context.Context, backend DeploymentBackend, manifest []byte, dryRun bool) (Result, error) {
	desiredBytes, desired, err := registry.Build(manifest)
	if err != nil {
		return Result{}, err
	}
	return applyRegistryProjection(ctx, backend, desiredBytes, desired, dryRun, nil, "registry publish")
}

// UnregisterSite requires the selected site to have been removed from the
// Git-owned manifest, then withdraws the registry projection and cleans the
// site's deployed content even when an earlier attempt already removed it.
func UnregisterSite(ctx context.Context, backend DeploymentBackend, manifest []byte, siteID string, dryRun bool) (Result, error) {
	result := Result{Operation: "registry unregister", Site: siteID}
	if err := validateLockSite(siteID); err != nil {
		return result, err
	}
	desiredBytes, desired, err := registry.Build(manifest)
	if err != nil {
		return result, err
	}
	if _, exists := registrySite(desired, siteID); exists {
		return result, fmt.Errorf("site %q is still present in the registry manifest; remove it before unregistering", siteID)
	}
	result, err = applyRegistryProjection(ctx, backend, desiredBytes, desired, dryRun, []string{siteID}, "registry unregister")
	result.Site = siteID
	return result, err
}

func applyRegistryProjection(ctx context.Context, backend DeploymentBackend, desiredBytes []byte, desired registry.Projection, dryRun bool, forcedCleanup []string, operationName string) (Result, error) {
	if backend == nil {
		return Result{}, errors.New("deployment backend is required")
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		return Result{}, errors.New("deployment backend does not support origin reads and conditional writes")
	}
	manager := SiteLockManager{Backend: conditional}
	var globalRelease func() error
	var err error
	if !dryRun {
		_, globalRelease, err = manager.AcquireRegistry(ctx)
		if err != nil {
			return Result{}, err
		}
	}
	operation := func() (result Result, operationErr error) {
		current, currentETag, err := readCurrentRegistry(ctx, conditional)
		if err != nil {
			return result, err
		}
		pendingCleanup, pendingETag, err := readRegistryCleanup(ctx, conditional)
		if err != nil {
			return result, err
		}
		plan, removed, changedExisting := diffRegistries(current, desired, currentETag == "")
		registryChanged := currentETag == "" || !sameRegistryEntries(current.Sites, desired.Sites)
		catalogInvalidationPending := registryChanged || pendingETag != ""
		desiredIDs := make(map[string]struct{}, len(desired.Sites))
		for _, entry := range desired.Sites {
			desiredIDs[entry.ID] = struct{}{}
		}
		cleanupCandidates := append(append(append([]string(nil), removed...), forcedCleanup...), pendingCleanup.Sites...)
		cleanupIDs := make([]string, 0, len(cleanupCandidates))
		for _, siteID := range uniqueSorted(cleanupCandidates) {
			if _, stillRegistered := desiredIDs[siteID]; !stillRegistered {
				cleanupIDs = append(cleanupIDs, siteID)
			}
		}
		registryUpdated := false
		plan = uniqueChanges(plan)
		result = Result{Operation: operationName, Changes: plan, RegistryUpdated: &registryUpdated}
		cleanupSet := make(map[string]struct{}, len(cleanupIDs))
		for _, siteID := range cleanupIDs {
			cleanupSet[siteID] = struct{}{}
		}
		preRegistryLockIDs := make([]string, 0, len(changedExisting))
		for _, siteID := range changedExisting {
			if _, cleanup := cleanupSet[siteID]; !cleanup {
				preRegistryLockIDs = append(preRegistryLockIDs, siteID)
			}
		}
		preRegistryLockIDs = uniqueSorted(preRegistryLockIDs)
		var locks []heldSiteLock
		if !dryRun {
			locks, err = acquireSiteLocks(ctx, manager, preRegistryLockIDs)
			if err != nil {
				return result, err
			}
			defer func() {
				if releaseErr := releaseLocks(locks); releaseErr != nil {
					if operationErr == nil {
						operationErr = fmt.Errorf("registry operation completed but site lock release failed: %w", releaseErr)
					} else {
						operationErr = errors.Join(operationErr, fmt.Errorf("release site locks: %w", releaseErr))
					}
				}
			}()
		}
		cleanupKeys := make([]string, 0)
		appendCleanupPlan := func() error {
			for _, siteID := range cleanupIDs {
				keys, err := listSiteKeys(ctx, backend, siteID)
				if err != nil {
					return fmt.Errorf("list site %q for cleanup: %w", siteID, err)
				}
				cleanupKeys = append(cleanupKeys, keys...)
				plan = append(plan, Change{Action: "remove", Path: "/" + siteID + "/*"})
				for _, key := range keys {
					plan = append(plan, Change{Action: "remove", Path: key})
				}
			}
			if catalogInvalidationPending {
				plan = append(plan, Change{Action: "invalidate", Path: "/_indexes/sites.json"})
			}
			for _, siteID := range cleanupIDs {
				plan = append(plan,
					Change{Action: "invalidate", Path: "/" + siteID},
					Change{Action: "invalidate", Path: "/" + siteID + "/*"},
					Change{Action: "invalidate", Path: "/_indexes/" + siteID + "/*"},
					Change{Action: "invalidate", Path: "/_artifacts/" + siteID + "/*"},
					Change{Action: "invalidate", Path: "/_previews/" + siteID + "/*"},
				)
			}
			sort.Strings(cleanupKeys)
			plan = uniqueChanges(plan)
			result.Changes = plan
			return nil
		}
		if dryRun {
			if err := appendCleanupPlan(); err != nil {
				return result, err
			}
			if len(plan) == 0 {
				result.Outcome = "no-op"
				return result, nil
			}
			result.Outcome = "planned"
			return result, nil
		}
		if len(plan) == 0 && len(cleanupIDs) == 0 && pendingETag == "" {
			result.Outcome = "no-op"
			return result, nil
		}
		if len(cleanupIDs) > 0 {
			if err := writeRegistryCleanup(ctx, conditional, cleanupIDs, pendingETag); err != nil {
				return result, err
			}
		}
		condition := ObjectCondition{IfMatchETag: currentETag}
		if currentETag == "" {
			condition = ObjectCondition{IfNoneMatch: true}
		}
		if registryChanged {
			if _, err := conditional.PutObjectConditional(ctx, "_indexes/sites.json", Object{
				Bytes: desiredBytes, ContentType: "application/json; charset=utf-8", ContentDisposition: "inline",
				Cache: indexCacheControl, Metadata: map[string]string{"artifact-pages-sha256": sha256Hex(desiredBytes)},
			}, condition); err != nil {
				return result, fmt.Errorf("publish registry projection: %w", err)
			}
			*result.RegistryUpdated = true
		}
		if len(cleanupIDs) > 0 {
			cleanupLocks, err := acquireSiteLocks(ctx, manager, cleanupIDs)
			if err != nil {
				return result, fmt.Errorf("registry published; acquire removed site locks: %w", err)
			}
			locks = append(locks, cleanupLocks...)
		}
		if err := appendCleanupPlan(); err != nil {
			return result, err
		}
		if len(cleanupKeys) > 0 {
			if err := backend.DeleteObjects(ctx, cleanupKeys); err != nil {
				return result, fmt.Errorf("registry published; clean removed site data: %w", err)
			}
		}
		result.FilesRemoved = len(cleanupKeys)
		paths := make([]string, 0, 1+len(cleanupIDs)*5)
		if catalogInvalidationPending {
			paths = append(paths, "/_indexes/sites.json")
		}
		for _, siteID := range cleanupIDs {
			paths = append(paths, "/"+siteID, "/"+siteID+"/*", "/_indexes/"+siteID+"/*", "/_artifacts/"+siteID+"/*", "/_previews/"+siteID+"/*")
		}
		if _, err := backend.Invalidate(ctx, paths); err != nil {
			return result, fmt.Errorf("registry published; cache revalidation failed: %w", err)
		}
		if pendingETag != "" || len(cleanupIDs) > 0 {
			if err := clearRegistryCleanup(ctx, backend); err != nil {
				return result, fmt.Errorf("registry and site cleanup completed; clear retry record: %w", err)
			}
		}
		if operationName == "registry unregister" {
			result.Outcome = "unregistered"
		} else {
			result.Outcome = "published"
		}
		return result, nil
	}
	result, operationErr := operation()
	if globalRelease != nil {
		if releaseErr := globalRelease(); releaseErr != nil {
			if operationErr == nil {
				operationErr = fmt.Errorf("registry operation completed but registry lock release failed: %w", releaseErr)
			} else {
				operationErr = errors.Join(operationErr, fmt.Errorf("release registry lock: %w", releaseErr))
			}
		}
	}
	if operationErr != nil {
		return result, operationErr
	}
	return result, nil
}

func readCurrentRegistry(ctx context.Context, backend ConditionalObjectBackend) (registry.Projection, string, error) {
	object, etag, err := backend.GetObject(ctx, "_indexes/sites.json")
	if errors.Is(err, ErrObjectNotFound) {
		return registry.Projection{SchemaVersion: registry.SchemaVersion, Sites: []registry.Entry{}}, "", nil
	}
	if err != nil {
		return registry.Projection{}, "", fmt.Errorf("read deployed registry: %w", err)
	}
	projection, err := registry.DecodeProjection(object.Bytes)
	if err != nil {
		return registry.Projection{}, "", fmt.Errorf("validate deployed registry: %w", err)
	}
	return projection, etag, nil
}

func diffRegistries(current, desired registry.Projection, firstApply bool) (changes []Change, removed, changedExisting []string) {
	oldSites := make(map[string]registry.Entry, len(current.Sites))
	newSites := make(map[string]registry.Entry, len(desired.Sites))
	for _, entry := range current.Sites {
		oldSites[entry.ID] = entry
	}
	for _, entry := range desired.Sites {
		newSites[entry.ID] = entry
	}
	for siteID, entry := range newSites {
		previous, exists := oldSites[siteID]
		switch {
		case !exists:
			changes = append(changes, Change{Action: "create", Path: "_indexes/sites.json#sites/" + siteID})
		case previous != entry:
			changes = append(changes, Change{Action: "update", Path: "_indexes/sites.json#sites/" + siteID})
			changedExisting = append(changedExisting, siteID)
		}
	}
	for siteID := range oldSites {
		if _, exists := newSites[siteID]; !exists {
			changes = append(changes, Change{Action: "remove", Path: "_indexes/sites.json#sites/" + siteID})
			removed = append(removed, siteID)
			changedExisting = append(changedExisting, siteID)
		}
	}
	if firstApply || !sameRegistryEntries(current.Sites, desired.Sites) {
		action := "update"
		if firstApply {
			action = "create"
		}
		changes = append(changes, Change{Action: action, Path: "_indexes/sites.json"})
	}
	sort.Slice(changes, func(i, j int) bool { return changes[i].Path < changes[j].Path })
	sort.Strings(removed)
	sort.Strings(changedExisting)
	return changes, removed, changedExisting
}

func sameRegistryEntries(left, right []registry.Entry) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func uniqueSorted(values []string) []string {
	sort.Strings(values)
	result := make([]string, 0, len(values))
	for _, value := range values {
		if len(result) == 0 || result[len(result)-1] != value {
			result = append(result, value)
		}
	}
	return result
}

func uniqueChanges(changes []Change) []Change {
	sort.Slice(changes, func(i, j int) bool {
		if changes[i].Path == changes[j].Path {
			return changes[i].Action < changes[j].Action
		}
		return changes[i].Path < changes[j].Path
	})
	result := make([]Change, 0, len(changes))
	for _, change := range changes {
		if len(result) == 0 || result[len(result)-1] != change {
			result = append(result, change)
		}
	}
	return result
}

type heldSiteLock struct {
	SiteID  string
	Release func() error
}

const registryCleanupKey = "_control/registry-cleanup.json"

type registryCleanupRecord struct {
	SchemaVersion int      `json:"schemaVersion"`
	Sites         []string `json:"sites"`
}

func readRegistryCleanup(ctx context.Context, backend ConditionalObjectBackend) (registryCleanupRecord, string, error) {
	object, etag, err := backend.GetObject(ctx, registryCleanupKey)
	if errors.Is(err, ErrObjectNotFound) {
		return registryCleanupRecord{SchemaVersion: 1, Sites: []string{}}, "", nil
	}
	if err != nil {
		return registryCleanupRecord{}, "", fmt.Errorf("read registry cleanup record: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
	decoder.DisallowUnknownFields()
	var record registryCleanupRecord
	if err := decoder.Decode(&record); err != nil {
		return registryCleanupRecord{}, "", fmt.Errorf("decode registry cleanup record: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return registryCleanupRecord{}, "", errors.New("registry cleanup record must contain exactly one JSON value")
	}
	if record.SchemaVersion != 1 || record.Sites == nil {
		return registryCleanupRecord{}, "", errors.New("registry cleanup record is invalid")
	}
	for index, siteID := range record.Sites {
		if err := validateLockSite(siteID); err != nil {
			return registryCleanupRecord{}, "", fmt.Errorf("registry cleanup record contains an invalid site: %w", err)
		}
		if index > 0 && record.Sites[index-1] >= siteID {
			return registryCleanupRecord{}, "", errors.New("registry cleanup record sites must be unique and sorted")
		}
	}
	return record, etag, nil
}

func writeRegistryCleanup(ctx context.Context, backend ConditionalObjectBackend, siteIDs []string, etag string) error {
	contents, err := json.Marshal(registryCleanupRecord{SchemaVersion: 1, Sites: siteIDs})
	if err != nil {
		return fmt.Errorf("encode registry cleanup record: %w", err)
	}
	condition := ObjectCondition{IfNoneMatch: true}
	if etag != "" {
		condition = ObjectCondition{IfMatchETag: etag}
	}
	if _, err := backend.PutObjectConditional(ctx, registryCleanupKey, Object{
		Bytes: contents, ContentType: "application/json; charset=utf-8", Cache: "no-store",
	}, condition); err != nil {
		return fmt.Errorf("write registry cleanup record: %w", err)
	}
	return nil
}

func clearRegistryCleanup(ctx context.Context, backend DeploymentBackend) error {
	if err := backend.DeleteObjects(ctx, []string{registryCleanupKey}); err != nil {
		return fmt.Errorf("clear registry cleanup record: %w", err)
	}
	return nil
}

func acquireSiteLocks(ctx context.Context, manager SiteLockManager, siteIDs []string) ([]heldSiteLock, error) {
	locks := make([]heldSiteLock, 0, len(siteIDs))
	for _, siteID := range siteIDs {
		if _, release, err := manager.Acquire(ctx, siteID); err != nil {
			releaseErr := releaseLocks(locks)
			if releaseErr != nil {
				err = errors.Join(err, fmt.Errorf("release previously acquired site locks: %w", releaseErr))
			}
			return nil, fmt.Errorf("acquire site %q lock for registry update: %w", siteID, err)
		} else {
			locks = append(locks, heldSiteLock{SiteID: siteID, Release: release})
		}
	}
	return locks, nil
}

func releaseLocks(locks []heldSiteLock) error {
	var failures []error
	for index := len(locks) - 1; index >= 0; index-- {
		if err := locks[index].Release(); err != nil {
			failures = append(failures, fmt.Errorf("release site %q lock: %w", locks[index].SiteID, err))
		}
	}
	return errors.Join(failures...)
}

func listSiteKeys(ctx context.Context, backend DeploymentBackend, siteID string) ([]string, error) {
	artifacts, err := backend.ListKeys(ctx, "_artifacts/"+siteID+"/")
	if err != nil {
		return nil, err
	}
	indexes, err := backend.ListKeys(ctx, "_indexes/"+siteID+"/")
	if err != nil {
		return nil, err
	}
	previews, err := backend.ListKeys(ctx, "_previews/"+siteID+"/")
	if err != nil {
		return nil, err
	}
	keys := append(append(artifacts, indexes...), previews...)
	sort.Strings(keys)
	return keys, nil
}
