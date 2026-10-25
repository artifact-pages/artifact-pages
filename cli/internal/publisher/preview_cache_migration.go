package publisher

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

// PreviewCacheMigrationOptions selects one site for the one-time Cache-Control
// migration of preview objects written by older CLIs.
type PreviewCacheMigrationOptions struct {
	SiteID string
	Apply  bool
}

// PreviewCacheMigrationObject reports one object considered by the migration.
// Action is "update", "current" or "expired".
type PreviewCacheMigrationObject struct {
	Key    string `json:"key"`
	Action string `json:"action"`
}

// PreviewCacheMigrationResult is the outcome of MigratePreviewCacheMetadata.
// Outcome is "planned", "migrated" or "no-op".
type PreviewCacheMigrationResult struct {
	Site             string                        `json:"site"`
	Outcome          string                        `json:"outcome"`
	Objects          []PreviewCacheMigrationObject `json:"objects"`
	Updated          int                           `json:"updated"`
	Current          int                           `json:"current"`
	ExpiredRevisions int                           `json:"expiredRevisions"`
}

type previewCacheTarget struct {
	key    string
	class  cacheObjectClass
	object Object
	etag   string
	action string
}

// MigratePreviewCacheMetadata rewrites only Cache-Control on the preview
// catalog, revision manifests and owned files of one site, and only for
// objects proven by the validated catalog ownership ledger and manifests.
// Dry-run (Apply=false) takes no lock and writes nothing.
func MigratePreviewCacheMetadata(ctx context.Context, backend ConditionalObjectBackend, options PreviewCacheMigrationOptions) (PreviewCacheMigrationResult, error) {
	result := PreviewCacheMigrationResult{Site: options.SiteID, Outcome: "no-op", Objects: []PreviewCacheMigrationObject{}}
	if ctx == nil {
		return result, errors.New("preview cache migration context is required")
	}
	if backend == nil {
		return result, errors.New("deployment backend is required")
	}
	if err := validateLockSite(options.SiteID); err != nil {
		return result, err
	}
	if err := ctx.Err(); err != nil {
		return result, err
	}
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		return result, err
	}
	if !options.Apply {
		targets, expired, err := planPreviewCacheMigration(ctx, backend, options.SiteID)
		if err != nil {
			return result, err
		}
		fillPreviewCacheMigrationResult(&result, targets, expired)
		if result.Updated > 0 {
			result.Outcome = "planned"
		}
		return result, nil
	}
	err = store.WithSiteLock(ctx, options.SiteID, func(locked context.Context) error {
		lock, ok := locked.Value(previewSiteLockContextKey{}).(previewSiteLock)
		if !ok {
			return errors.New("preview cache migration requires an active site lock")
		}
		targets, expired, err := planPreviewCacheMigration(locked, backend, options.SiteID)
		if err != nil {
			return err
		}
		fillPreviewCacheMigrationResult(&result, targets, expired)
		updated := 0
		for _, target := range targets {
			if target.action != "update" {
				continue
			}
			if err := store.verifySiteLock(locked, options.SiteID, lock); err != nil {
				return fmt.Errorf("preview cache migration stopped before %s: %w", target.key, err)
			}
			object := target.object
			object.Cache = cacheControl(target.class)
			if _, err := backend.PutObjectConditional(locked, target.key, object, ObjectCondition{IfMatchETag: target.etag}); err != nil {
				return fmt.Errorf("update Cache-Control of preview object %s: %w", target.key, err)
			}
			updated++
		}
		if updated > 0 {
			result.Outcome = "migrated"
		}
		return nil
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

func fillPreviewCacheMigrationResult(result *PreviewCacheMigrationResult, targets []previewCacheTarget, expired []string) {
	result.Objects = []PreviewCacheMigrationObject{}
	result.Updated, result.Current, result.ExpiredRevisions = 0, 0, len(expired)
	for _, target := range targets {
		result.Objects = append(result.Objects, PreviewCacheMigrationObject{Key: target.key, Action: target.action})
		if target.action == "update" {
			result.Updated++
		} else {
			result.Current++
		}
	}
	for _, key := range expired {
		result.Objects = append(result.Objects, PreviewCacheMigrationObject{Key: key, Action: "expired"})
	}
}

// planPreviewCacheMigration reads and validates everything before any write.
// It returns the catalog and owned objects in write order and the manifest keys
// of revisions whose objects have all expired.
func planPreviewCacheMigration(ctx context.Context, backend ConditionalObjectBackend, site string) ([]previewCacheTarget, []string, error) {
	catalogKey, err := preview.CatalogKey(site)
	if err != nil {
		return nil, nil, err
	}
	rawCatalogKey, err := preview.RawObjectKey(catalogKey)
	if err != nil {
		return nil, nil, err
	}
	catalogObject, catalogETag, err := backend.GetObject(ctx, rawCatalogKey)
	if errors.Is(err, ErrObjectNotFound) {
		return nil, nil, nil
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read preview catalog: %w", err)
	}
	// The bytes validated here are the bytes and ETag later written back.
	catalog, err := preview.DecodeCatalog(catalogObject.Bytes)
	if err != nil {
		return nil, nil, fmt.Errorf("existing preview catalog is invalid: %w", err)
	}
	if catalog.Site != site {
		return nil, nil, fmt.Errorf("preview catalog site %q does not match %q", catalog.Site, site)
	}
	if err := preview.ValidateCatalog(catalog); err != nil {
		return nil, nil, fmt.Errorf("existing preview catalog is invalid: %w", err)
	}
	owned := make(map[string]preview.RevisionOwnership)
	for _, history := range catalog.RevisionHistory {
		for _, revision := range history.Revisions {
			if prior, exists := owned[revision.HeadSHA]; exists {
				if !sameStringSlice(prior.Files, revision.Files) {
					return nil, nil, fmt.Errorf("preview revision %s has inconsistent file ownership across groups", revision.HeadSHA)
				}
				continue
			}
			owned[revision.HeadSHA] = revision
		}
	}
	shas := make([]string, 0, len(owned))
	for sha := range owned {
		shas = append(shas, sha)
	}
	sort.Strings(shas)

	type pendingTarget struct {
		key      string
		class    cacheObjectClass
		object   Object
		etag     string
		prefetch bool
	}
	pending := []pendingTarget{{key: rawCatalogKey, class: cacheClassPreviewCatalog, object: catalogObject, etag: catalogETag, prefetch: true}}
	expired := []string{}
	for _, sha := range shas {
		ownership := owned[sha]
		manifestKey, err := preview.ManifestKey(site, sha)
		if err != nil {
			return nil, nil, err
		}
		rawManifest, err := preview.RawObjectKey(manifestKey)
		if err != nil {
			return nil, nil, err
		}
		fileKeys := make([]string, 0, len(ownership.Files))
		for _, file := range ownership.Files {
			fileKey, err := preview.FileKey(site, sha, file)
			if err != nil {
				return nil, nil, err
			}
			raw, err := preview.RawObjectKey(fileKey)
			if err != nil {
				return nil, nil, err
			}
			fileKeys = append(fileKeys, raw)
		}
		manifestObject, manifestETag, manifestErr := backend.GetObject(ctx, rawManifest)
		switch {
		case manifestErr == nil:
			if err := verifyManifestContents(site, ownership, manifestObject.Bytes); err != nil {
				return nil, nil, err
			}
			pending = append(pending, pendingTarget{key: rawManifest, class: cacheClassPreviewFile, object: manifestObject, etag: manifestETag, prefetch: true})
			for index, raw := range fileKeys {
				if _, err := backend.HeadObject(ctx, raw); err != nil {
					if errors.Is(err, ErrObjectNotFound) {
						return nil, nil, fmt.Errorf("preview revision %s is missing owned file %s", sha, ownership.Files[index])
					}
					return nil, nil, fmt.Errorf("check preview revision %s file %s: %w", sha, ownership.Files[index], err)
				}
				pending = append(pending, pendingTarget{key: raw, class: cacheClassPreviewFile})
			}
		case errors.Is(manifestErr, ErrObjectNotFound):
			for index, raw := range fileKeys {
				_, err := backend.HeadObject(ctx, raw)
				if err == nil {
					return nil, nil, fmt.Errorf("preview revision %s has no manifest but still has owned file %s", sha, ownership.Files[index])
				}
				if !errors.Is(err, ErrObjectNotFound) {
					return nil, nil, fmt.Errorf("check preview revision %s file %s: %w", sha, ownership.Files[index], err)
				}
			}
			expired = append(expired, rawManifest)
		default:
			return nil, nil, fmt.Errorf("read preview manifest for %s: %w", sha, manifestErr)
		}
	}

	targets := make([]previewCacheTarget, 0, len(pending))
	for _, item := range pending {
		object, etag := item.object, item.etag
		if !item.prefetch {
			var err error
			object, etag, err = backend.GetObject(ctx, item.key)
			if err != nil {
				return nil, nil, fmt.Errorf("read preview object %s: %w", item.key, err)
			}
		}
		target := previewCacheTarget{key: item.key, class: item.class, object: object, etag: etag}
		switch {
		case object.Cache == cacheControl(item.class):
			target.action = "current"
		case cacheControlAccepted(item.class, object.Cache):
			target.action = "update"
		default:
			return nil, nil, fmt.Errorf("preview object %s has an unsupported Cache-Control policy", item.key)
		}
		if target.action == "update" && etag == "" {
			return nil, nil, fmt.Errorf("preview object %s has no ETag", item.key)
		}
		targets = append(targets, target)
	}
	return targets, expired, nil
}
