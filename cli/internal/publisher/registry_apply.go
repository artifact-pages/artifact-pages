package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"io"
	"sort"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

// RegisterSites reconciles the complete desired registration set from the
// set. A real apply holds a registry lock and site locks for changed existing
// identities; sites omitted from the selected config are unregistered and cleaned.
// A dry-run is read-only and returns the same sorted plan.
func RegisterSites(ctx context.Context, backend DeploymentBackend, desired registry.Projection, dryRun bool) (Result, error) {
	desiredBytes, err := registry.Encode(desired)
	if err != nil {
		return Result{}, err
	}
	desired, err = registry.DecodeProjection(desiredBytes)
	if err != nil {
		return Result{}, err
	}
	return applyRegistryProjection(ctx, backend, desiredBytes, desired, dryRun, nil, "registry sync")
}

// UnregisterSite requires the selected site to have been removed from the
// selected config, then withdraws the registry projection and cleans the
// site's deployed content even when an earlier attempt already removed it.
func UnregisterSite(ctx context.Context, backend DeploymentBackend, desired registry.Projection, siteID string, dryRun bool) (Result, error) {
	result := Result{Operation: "registry unregister", Site: siteID}
	if err := validateLockSite(siteID); err != nil {
		return result, err
	}
	desiredBytes, err := registry.Encode(desired)
	if err != nil {
		return result, err
	}
	desired, err = registry.DecodeProjection(desiredBytes)
	if err != nil {
		return result, err
	}
	if _, exists := registrySite(desired, siteID); exists {
		return result, fmt.Errorf("site %q is still present in config sites; remove it before unregistering", siteID)
	}
	result, err = applyRegistryProjection(ctx, backend, desiredBytes, desired, dryRun, []string{siteID}, "registry sync")
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
	if err := checkWriter(ctx, conditional, compatCurrentWrites()); err != nil {
		return Result{}, err
	}
	record, err := prepareWriterRecord(ctx, conditional, registryVersionsKey, writerFormats("registry"))
	if err != nil {
		return Result{}, err
	}
	if err := checkRegistrySiteRecordSchemas(ctx, conditional); err != nil {
		return Result{}, err
	}
	manager := SiteLockManager{Backend: conditional}
	var globalRelease func() error
	if !dryRun {
		_, globalRelease, err = manager.AcquireRegistry(ctx)
		if err != nil {
			return Result{}, err
		}
	}
	operation := func() (result Result, operationErr error) {
		record, err = prepareWriterRecord(ctx, conditional, registryVersionsKey, writerFormats("registry"))
		if err != nil {
			return result, err
		}
		if err := checkWriter(ctx, conditional, compatCurrentWrites()); err != nil {
			return result, err
		}
		defer func() {
			if operationErr == nil && !dryRun {
				operationErr = writeVersionRecord(ctx, backend, registryVersionsKey, record)
			}
		}()
		if err := checkRegistrySiteRecordSchemas(ctx, conditional); err != nil {
			return result, err
		}
		current, currentETag, currentCache, err := readCurrentRegistry(ctx, conditional)
		if err != nil {
			return result, err
		}
		pendingCleanup, pendingETag, err := readRegistryCleanup(ctx, conditional)
		if err != nil {
			return result, err
		}
		plan, removed, changedExisting := diffRegistries(current, desired, currentETag == "")
		registryHeaderChanged := false
		if currentETag != "" {
			if !cacheControlAccepted(cacheClassSiteRoot, currentCache) {
				return result, errors.New("deployed registry has an unsupported Cache-Control policy")
			}
			registryHeaderChanged = currentCache != cacheControl(cacheClassSiteRoot)
		}
		registryChanged := currentETag == "" || !sameRegistryEntries(current.Sites, desired.Sites) || registryHeaderChanged
		if registryHeaderChanged && sameRegistryEntries(current.Sites, desired.Sites) {
			plan = append(plan, Change{Action: "update", Path: "_indexes/sites.json"})
		}
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
		// All affected identities are locked before catalog mutation so their
		// version records cannot change after the compatibility preflight.
		preRegistryLockIDs := uniqueSorted(append(append([]string(nil), changedExisting...), cleanupIDs...))
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
		for _, lock := range locks {
			if _, _, err := readVersionRecord(ctx, conditional, siteVersionsKey(lock.SiteID)); err != nil {
				return result, err
			}
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
			sort.Strings(cleanupKeys)
			plan = uniqueChanges(plan)
			result.Changes = plan
			return nil
		}
		if dryRun {
			if err := appendCleanupPlan(); err != nil {
				return result, err
			}
			if len(plan) == 0 && pendingETag == "" {
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
		if pendingCleanup.legacyRecord && len(cleanupIDs) > 0 {
			newETag, err := writeRegistryCleanup(ctx, conditional, registryCleanupRecord{SchemaVersion: 2, Sites: cleanupIDs}, pendingETag)
			if err != nil {
				return result, err
			}
			pendingETag = newETag
		} else if len(cleanupIDs) > 0 {
			cleanupRecord := registryCleanupRecord{SchemaVersion: 2, Sites: cleanupIDs}
			if pendingETag == "" || !sameRegistryCleanupRecord(pendingCleanup, cleanupRecord) {
				newETag, err := writeRegistryCleanup(ctx, conditional, cleanupRecord, pendingETag)
				if err != nil {
					return result, err
				}
				pendingETag = newETag
			}
		}
		condition := ObjectCondition{IfMatchETag: currentETag}
		if currentETag == "" {
			condition = ObjectCondition{IfNoneMatch: true}
		}
		if err := stageVersionRecord(ctx, conditional, registryVersionsKey, record); err != nil {
			return result, err
		}
		if registryChanged {
			if _, err := conditional.PutObjectConditional(ctx, "_indexes/sites.json", Object{
				Bytes: desiredBytes, ContentType: "application/json; charset=utf-8", ContentDisposition: "inline",
				Cache: cacheControl(cacheClassSiteRoot), Metadata: map[string]string{"artifact-pages-sha256": sha256Hex(desiredBytes)},
			}, condition); err != nil {
				return result, fmt.Errorf("write registry projection: %w", err)
			}
			*result.RegistryUpdated = true
		}
		if len(cleanupIDs) > 0 {
			cleanupLocks := make([]heldSiteLock, 0, len(cleanupIDs))
			for _, lock := range locks {
				if _, cleanup := cleanupSet[lock.SiteID]; cleanup {
					cleanupLocks = append(cleanupLocks, lock)
				}
			}
			previewStore, err := NewObjectPreviewStore(conditional)
			if err != nil {
				return result, err
			}
			for _, lock := range cleanupLocks {
				lockContext := context.WithValue(ctx, previewSiteLockContextKey{}, previewSiteLock{
					site: lock.Snapshot.Site, owner: lock.Snapshot.Owner, etag: lock.Snapshot.ETag,
				})
				if _, _, err := resumePreviewCleanup(lockContext, backend, conditional, previewStore); err != nil {
					return result, fmt.Errorf("registry updated; resume preview cleanup for removed site %q: %w", lock.SiteID, err)
				}
			}
		}
		if err := appendCleanupPlan(); err != nil {
			return result, err
		}
		if len(cleanupKeys) > 0 {
			if err := backend.DeleteObjects(ctx, cleanupKeys); err != nil {
				return result, fmt.Errorf("registry updated; clean removed site data: %w", err)
			}
		}
		if err := writeVersionRecord(ctx, backend, registryVersionsKey, record); err != nil {
			return result, err
		}
		result.FilesRemoved = len(cleanupKeys)
		if pendingETag != "" {
			if err := clearRegistryCleanup(ctx, backend); err != nil {
				return result, fmt.Errorf("registry and site cleanup completed; clear retry record: %w", err)
			}
		}
		result.Outcome = "synced"
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

func sameRegistryCleanupRecord(left, right registryCleanupRecord) bool {
	return left.SchemaVersion == right.SchemaVersion && sameStringSlice(left.Sites, right.Sites)
}

func readCurrentRegistry(ctx context.Context, backend ConditionalObjectBackend) (registry.Projection, string, string, error) {
	object, etag, err := backend.GetObject(ctx, "_indexes/sites.json")
	if errors.Is(err, ErrObjectNotFound) {
		return registry.Projection{SchemaVersion: registry.SchemaVersion, Sites: []registry.Entry{}}, "", "", nil
	}
	if err != nil {
		return registry.Projection{}, "", "", fmt.Errorf("read deployed registry: %w", err)
	}
	projection, err := registry.DecodeProjection(object.Bytes)
	if err != nil {
		return registry.Projection{}, "", "", fmt.Errorf("validate deployed registry: %w", err)
	}
	cacheControl := object.Cache
	if cacheControl == "" {
		// A local directory projection has no HTTP headers unless its metadata
		// sidecar exists. HeadObject supplies the class policy it infers for that
		// local representation; provider objects with a missing header fail closed.
		if _, local := backend.(*DirectoryBackend); local {
			info, headErr := backend.HeadObject(ctx, "_indexes/sites.json")
			if headErr != nil {
				return registry.Projection{}, "", "", fmt.Errorf("inspect deployed registry metadata: %w", headErr)
			}
			if info.ETag != etag {
				return registry.Projection{}, "", "", errors.New("deployed registry changed between GET and HEAD; retry registry sync")
			}
			cacheControl = info.CacheControl
		}
	}
	return projection, etag, cacheControl, nil
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
	SiteID   string
	Snapshot LockSnapshot
	Release  func() error
}

const registryCleanupKey = "_control/registry-cleanup.json"

type registryCleanupRecord struct {
	SchemaVersion int      `json:"schemaVersion"`
	Sites         []string `json:"sites"`
	legacyRecord  bool
}

func readRegistryCleanup(ctx context.Context, backend ConditionalObjectBackend) (registryCleanupRecord, string, error) {
	object, etag, err := backend.GetObject(ctx, registryCleanupKey)
	if errors.Is(err, ErrObjectNotFound) {
		return registryCleanupRecord{SchemaVersion: 2, Sites: []string{}}, "", nil
	}
	if err != nil {
		return registryCleanupRecord{}, "", fmt.Errorf("read registry cleanup record: %w", err)
	}
	if strings.TrimSpace(etag) == "" {
		return registryCleanupRecord{}, "", errors.New("registry cleanup record has no ETag for compare-and-swap")
	}
	if len(object.Bytes) > maxRegistryCleanupBytes {
		return registryCleanupRecord{}, "", fmt.Errorf("registry cleanup record exceeds %d bytes", maxRegistryCleanupBytes)
	}
	if err := validateNoDuplicateJSONKeys(object.Bytes); err != nil {
		return registryCleanupRecord{}, "", fmt.Errorf("validate registry cleanup record: %w", err)
	}
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(object.Bytes, &header); err != nil {
		return registryCleanupRecord{}, "", errors.New("registry cleanup record must be an object")
	}
	if header.SchemaVersion != 1 && header.SchemaVersion != 2 {
		return registryCleanupRecord{}, "", compat.CheckSchemaVersion("registry cleanup record", object.Bytes, 2)
	}
	if header.SchemaVersion == 1 {
		var old struct {
			SchemaVersion int      `json:"schemaVersion"`
			Sites         []string `json:"sites"`
			Paths         []string `json:"paths"`
		}
		decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&old); err != nil {
			return registryCleanupRecord{}, "", fmt.Errorf("decode legacy registry cleanup record: %w", err)
		}
		if old.SchemaVersion != 1 || old.Paths == nil {
			return registryCleanupRecord{}, "", errors.New("legacy registry cleanup record is missing required fields")
		}
		if err := validateRegistryCleanupSites(old.Sites); err != nil {
			return registryCleanupRecord{}, "", err
		}
		if err := validateLegacyRegistryCleanupPaths(old.Paths); err != nil {
			return registryCleanupRecord{}, "", err
		}
		if len(old.Paths) == 0 {
			return registryCleanupRecord{}, "", errors.New("legacy registry cleanup record has no validated paths")
		}
		set := make(map[string]bool)
		for _, x := range old.Paths {
			set[x] = true
		}
		for _, id := range old.Sites {
			for _, x := range legacyRegistryCleanupRequiredPaths(true, []string{id}) {
				if !set[x] {
					return registryCleanupRecord{}, "", fmt.Errorf("legacy registry cleanup record for %s is incomplete", id)
				}
			}
		}
		return registryCleanupRecord{SchemaVersion: 2, Sites: old.Sites, legacyRecord: true}, etag, nil
	}
	decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
	var record registryCleanupRecord
	if err := decoder.Decode(&record); err != nil {
		return registryCleanupRecord{}, "", fmt.Errorf("decode registry cleanup record: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return registryCleanupRecord{}, "", errors.New("registry cleanup record must contain exactly one JSON value")
	}
	if err := validateRegistryCleanupRecord(record); err != nil {
		return registryCleanupRecord{}, "", err
	}
	return record, etag, nil
}

const maxRegistryCleanupBytes = 8 << 20

func validateLegacyRegistryCleanupPaths(paths []string) error {
	if paths == nil {
		return errors.New("registry cleanup paths must be an array")
	}
	for i, p := range paths {
		if !isLegacyRegistryCleanupPath(p) {
			return fmt.Errorf("registry cleanup record contains unsupported path %q", p)
		}
		if i > 0 && paths[i-1] >= p {
			return errors.New("registry cleanup paths must be sorted and unique")
		}
	}
	return nil
}
func legacyRegistryCleanupRequiredPaths(catalog bool, sites []string) []string {
	var paths []string
	if catalog {
		paths = append(paths, "/_indexes/sites.json")
	}
	for _, id := range sites {
		paths = append(paths, "/"+id, "/"+id+"/*", "/_indexes/"+id+"/*", "/_artifacts/"+id+"/*", "/_previews/"+id+"/*")
	}
	return uniqueSorted(paths)
}
func isLegacyRegistryCleanupPath(path string) bool {
	if path == "/_indexes/sites.json" {
		return true
	}
	for _, prefix := range []string{"/_indexes/", "/_artifacts/", "/_previews/"} {
		if strings.HasPrefix(path, prefix) && strings.HasSuffix(path, "/*") {
			return validateLockSite(strings.TrimSuffix(strings.TrimPrefix(path, prefix), "/*")) == nil
		}
	}
	if strings.HasPrefix(path, "/") && !strings.HasPrefix(path, "//") {
		id := strings.TrimPrefix(path, "/")
		if strings.HasSuffix(id, "/*") {
			id = strings.TrimSuffix(id, "/*")
		}
		return validateLockSite(id) == nil
	}
	return false
}
func validateRegistryCleanupSites(sites []string) error {
	if sites == nil {
		return errors.New("registry cleanup sites must be an array")
	}
	for i, id := range sites {
		if err := validateLockSite(id); err != nil {
			return fmt.Errorf("registry cleanup record contains invalid site: %w", err)
		}
		if i > 0 && sites[i-1] >= id {
			return errors.New("registry cleanup sites must be sorted and unique")
		}
	}
	return nil
}

func validateRegistryCleanupRecord(record registryCleanupRecord) error {
	if record.SchemaVersion != 2 {
		return errors.New("registry cleanup record has unsupported schema")
	}
	return validateRegistryCleanupSites(record.Sites)
}

func writeRegistryCleanup(ctx context.Context, backend ConditionalObjectBackend, record registryCleanupRecord, etag string) (string, error) {
	if err := validateRegistryCleanupRecord(record); err != nil {
		return "", err
	}
	contents, err := json.Marshal(record)
	if err != nil {
		return "", fmt.Errorf("encode registry cleanup record: %w", err)
	}
	if len(contents) > maxRegistryCleanupBytes {
		return "", fmt.Errorf("registry cleanup record exceeds %d bytes", maxRegistryCleanupBytes)
	}
	condition := ObjectCondition{IfNoneMatch: true}
	if strings.TrimSpace(etag) != "" {
		condition = ObjectCondition{IfMatchETag: etag}
	}
	newETag, err := backend.PutObjectConditional(ctx, registryCleanupKey, Object{
		Bytes: contents, ContentType: "application/json; charset=utf-8", Cache: cacheControl(cacheClassPrivateControl),
	}, condition)
	if err != nil {
		return "", fmt.Errorf("write registry cleanup record: %w", err)
	}
	if strings.TrimSpace(newETag) == "" {
		return "", errors.New("registry cleanup record write returned no ETag")
	}
	return newETag, nil
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
		if snapshot, release, err := manager.Acquire(ctx, siteID); err != nil {
			releaseErr := releaseLocks(locks)
			if releaseErr != nil {
				err = errors.Join(err, fmt.Errorf("release previously acquired site locks: %w", releaseErr))
			}
			return nil, fmt.Errorf("acquire site %q lock for registry update: %w", siteID, err)
		} else {
			locks = append(locks, heldSiteLock{SiteID: siteID, Snapshot: snapshot, Release: release})
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
	if conditional, ok := backend.(ConditionalObjectBackend); ok {
		// Cover both layouts: a site never touched by a post-IMP-66 CLI still
		// holds its records at the legacy keys, and unregister must clear them.
		for _, retryKey := range []string{siteCacheRetryKey(siteID), legacySiteCacheRetryKey(siteID), siteVersionsKey(siteID)} {
			if _, _, err := conditional.GetObject(ctx, retryKey); err == nil {
				keys = append(keys, retryKey)
			} else if !errors.Is(err, ErrObjectNotFound) && (retryKey == siteCacheRetryKey(siteID) || !legacyProbeAbsent(err)) {
				return nil, fmt.Errorf("read site cache retry record for cleanup: %w", err)
			}
		}
		// Check only the exact fixed key prefix, without reading or decoding it,
		// so unregister can clean malformed or crash-interrupted state while
		// keeping FilesRemoved accurate for an already-absent state object.
		for _, stateKey := range []string{sitePublishStateKey(siteID), legacySitePublishStateKey(siteID)} {
			stateKeys, err := backend.ListKeys(ctx, stateKey)
			if err != nil {
				if stateKey != sitePublishStateKey(siteID) && legacyProbeAbsent(err) {
					continue
				}
				return nil, fmt.Errorf("list site publish state for cleanup: %w", err)
			}
			for _, key := range stateKeys {
				if key == stateKey {
					keys = append(keys, key)
					break
				}
			}
		}
	}
	sort.Strings(keys)
	return keys, nil
}
