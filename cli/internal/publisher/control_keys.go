package publisher

import (
	"context"
	"errors"
	"fmt"
)

// Control-record layout (IMP-66, TD15).
//
// Every record that belongs to one site lives under _control/sites/<site>/ so
// a provider credential scoped to that prefix covers any current or future
// per-site record without enumerating keys. Records that belong to the whole
// registry or application plane stay at fixed keys outside that prefix.
//
// The pre-IMP-66 per-site keys are "legacy" keys. This CLI never writes them.
// It reads them only to adopt state written by an older CLI and then removes
// them (migrateLegacySiteControl, acquireLegacySiteLock).
const siteControlRoot = "_control/sites/"

// Fixed keys for records that belong to the whole registry or application
// plane. They are admin-only and are not covered by a per-site prefix.
const (
	registryLockKey    = "_control/locks/registry.json"
	applicationLockKey = "_control/locks/application.json"
)

// siteControlPrefix is the only prefix a site's storage credential may use
// for control records. Site identifiers match lockSiteIDPattern, so they never
// contain "/" or "..".
func siteControlPrefix(site string) string { return siteControlRoot + site + "/" }

func siteLockKey(site string) string       { return siteControlPrefix(site) + "lock.json" }
func siteCacheRetryKey(site string) string { return siteControlPrefix(site) + "site-cache.json" }
func previewCleanupKey(site string) string { return siteControlPrefix(site) + "preview-cleanup.json" }
func sitePublishStateKey(site string) string {
	return siteControlPrefix(site) + "publish-state.json.gz"
}

func legacySiteLockKey(site string) string { return "_control/locks/sites/" + site + ".json" }
func legacySiteCacheRetryKey(site string) string {
	return "_control/site-cache/" + site + ".json"
}
func legacyPreviewCleanupKey(site string) string {
	return "_control/preview-cleanup/" + site + ".json"
}
func legacySitePublishStateKey(site string) string {
	return "_control/publish-state/" + site + ".json.gz"
}

// legacyKeyOf maps a current per-site control key to its pre-IMP-66 key.
func legacyKeyOf(site, key string) string {
	switch key {
	case siteLockKey(site):
		return legacySiteLockKey(site)
	case siteCacheRetryKey(site):
		return legacySiteCacheRetryKey(site)
	case previewCleanupKey(site):
		return legacyPreviewCleanupKey(site)
	case sitePublishStateKey(site):
		return legacySitePublishStateKey(site)
	}
	return ""
}

// legacyProbeAbsent reports whether an error from reading a legacy key means
// "nothing there for this credential". After the module drops the old grants,
// S3 answers 403 for those keys, which must not block the new layout.
func legacyProbeAbsent(err error) bool {
	return errors.Is(err, ErrObjectNotFound) || isS3ResponseStatus(err, 403) || isS3APIErrorCode(err, "AccessDenied")
}

// legacyReadAllowed is true for read-only (dry-run) callers that do not hold
// the site lock and therefore never migrate. Locked callers have already
// migrated, so they skip the extra legacy request.
func legacyReadAllowed(ctx context.Context) bool {
	_, locked := ctx.Value(previewSiteLockContextKey{}).(previewSiteLock)
	return !locked
}

// getSiteControl reads a per-site control record. A dry-run caller that finds
// no current record falls back to the legacy key so that it plans against the
// state a real run would adopt; that ETag is only meaningful for reads.
func getSiteControl(ctx context.Context, backend ConditionalObjectBackend, site, key string) (Object, string, error) {
	object, etag, err := backend.GetObject(ctx, key)
	if !errors.Is(err, ErrObjectNotFound) || !legacyReadAllowed(ctx) {
		return object, etag, err
	}
	legacy := legacyKeyOf(site, key)
	if legacy == "" {
		return object, etag, err
	}
	legacyObject, legacyETag, legacyErr := backend.GetObject(ctx, legacy)
	if legacyErr != nil {
		if legacyProbeAbsent(legacyErr) {
			return Object{}, "", err
		}
		return Object{}, "", legacyErr
	}
	return legacyObject, legacyETag, nil
}

// headSiteControl is the HEAD analogue of getSiteControl.
func headSiteControl(ctx context.Context, backend ConditionalObjectBackend, site, key string) (ObjectInfo, error) {
	info, err := backend.HeadObject(ctx, key)
	if !errors.Is(err, ErrObjectNotFound) || !legacyReadAllowed(ctx) {
		return info, err
	}
	legacy := legacyKeyOf(site, key)
	if legacy == "" {
		return info, err
	}
	legacyInfo, legacyErr := backend.HeadObject(ctx, legacy)
	if legacyErr != nil {
		if legacyProbeAbsent(legacyErr) {
			return ObjectInfo{}, err
		}
		return ObjectInfo{}, legacyErr
	}
	return legacyInfo, nil
}

// migrateLegacySiteControl adopts per-site records written by a pre-IMP-66
// CLI. It runs once per site, from the lock adoption step
// (SiteLockManager.adoptLegacySite), while the legacy lock is held. Each
// legacy record found is copied to its new key with If-None-Match and only then deleted, so a crash
// leaves the legacy record in place and the next run resumes. The new key
// always wins on read, and the legacy key is removed in the same step that
// creates the new one, so a stale legacy record cannot override newer state.
func migrateLegacySiteControl(ctx context.Context, backend ConditionalObjectBackend, site string) error {
	for _, key := range []string{siteCacheRetryKey(site), previewCleanupKey(site), sitePublishStateKey(site)} {
		legacy := legacyKeyOf(site, key)
		object, _, err := backend.GetObject(ctx, legacy)
		if err != nil {
			if legacyProbeAbsent(err) {
				continue
			}
			return fmt.Errorf("read legacy control record %s: %w", legacy, err)
		}
		if _, err := backend.PutObjectConditional(ctx, key, object, ObjectCondition{IfNoneMatch: true}); err != nil && !errors.Is(err, ErrPreconditionFailed) {
			return fmt.Errorf("adopt legacy control record %s as %s: %w", legacy, key, err)
		}
		if err := backend.DeleteObjects(ctx, []string{legacy}); err != nil {
			return fmt.Errorf("remove legacy control record %s after adoption: %w", legacy, err)
		}
	}
	return nil
}
