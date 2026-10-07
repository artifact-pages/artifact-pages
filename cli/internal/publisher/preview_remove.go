package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

const (
	previewCleanupSchema    = 1
	maxPreviewCleanupBytes  = 16 << 20
	previewCleanupPathLimit = 250000
)

type PreviewRemoveOptions struct {
	SiteID  string
	GroupID string
	DryRun  bool
}

type previewCleanupRecord struct {
	SchemaVersion int                         `json:"schemaVersion"`
	Site          string                      `json:"site"`
	GroupID       string                      `json:"groupId"`
	Revisions     []preview.RevisionOwnership `json:"revisions"`
	ObjectKeys    []string                    `json:"objectKeys"`
	Paths         []string                    `json:"paths"`
}

type previewRemovalPlan struct {
	journal  previewCleanupRecord
	hasGroup bool
}

// PlanPreviewRemoval performs all ownership, manifest, and invalidation checks
// without taking a lock or changing provider state.
func PlanPreviewRemoval(ctx context.Context, backend DeploymentBackend, options PreviewRemoveOptions) (Result, error) {
	result := previewRemoveResult(options)
	conditional, store, err := previewRemovalDependencies(ctx, backend, options)
	if err != nil {
		return result, err
	}
	pending, _, err := readPreviewCleanup(ctx, conditional, options.SiteID)
	if err != nil {
		return result, err
	}
	if pending != nil && pending.GroupID != options.GroupID {
		return result, pendingPreviewCleanupError(options.SiteID, pending.GroupID)
	}
	catalog, err := readPreviewCatalog(ctx, store, options.SiteID)
	if err != nil {
		return result, err
	}
	if pending != nil {
		// Dry-run reports existing work without recovering it. Simulate its
		// catalog transition in memory before planning the requested group.
		catalog = removeCatalogGroup(catalog, pending.GroupID)
		appendPreviewCleanupChanges(&result, *pending)
	}
	plan, err := planPreviewRemoval(ctx, backend, store, options.SiteID, options.GroupID, catalog)
	if err != nil {
		return result, err
	}
	if plan.hasGroup {
		appendPreviewCleanupChanges(&result, plan.journal)
	}
	result.Changes = uniqueChanges(result.Changes)
	result.InvalidationPaths = uniqueSorted(result.InvalidationPaths)
	result.FilesRemoved = countRemovedChanges(result.Changes)
	if pending != nil || plan.hasGroup {
		result.Outcome = "planned"
	} else {
		result.Outcome = "no-op"
	}
	if err := validateInvalidation(backend, result.InvalidationPaths); err != nil {
		return result, err
	}
	result.InvalidationPaths = plannedInvalidationPaths(backend, result.InvalidationPaths)
	return result, nil
}

// RemovePreviewGroup removes one explicit preview group under the site's
// cooperative lock. Its durable journal makes catalog, object, and cache
// stages safe to retry after partial failure or an ambiguous response.
func RemovePreviewGroup(ctx context.Context, backend DeploymentBackend, options PreviewRemoveOptions) (Result, error) {
	result := previewRemoveResult(options)
	conditional, store, err := previewRemovalDependencies(ctx, backend, options)
	if err != nil {
		return result, err
	}
	if options.DryRun {
		return PlanPreviewRemoval(ctx, backend, options)
	}
	result.Changes = []Change{}
	result.InvalidationPaths = []string{}
	err = store.WithSiteLock(ctx, options.SiteID, func(lockedContext context.Context) error {
		pendingBeforeResume, _, err := readPreviewCleanup(lockedContext, conditional, options.SiteID)
		if err != nil {
			return err
		}
		if pendingBeforeResume != nil && pendingBeforeResume.GroupID != options.GroupID {
			return pendingPreviewCleanupError(options.SiteID, pendingBeforeResume.GroupID)
		}
		pending, resumed, err := resumePreviewCleanup(lockedContext, backend, conditional, store)
		if err != nil {
			return err
		}
		if resumed {
			appendPreviewCleanupChanges(&result, *pending)
		}
		catalog, err := readPreviewCatalog(lockedContext, store, options.SiteID)
		if err != nil {
			return err
		}
		plan, err := planPreviewRemoval(lockedContext, backend, store, options.SiteID, options.GroupID, catalog)
		if err != nil {
			return err
		}
		if !plan.hasGroup {
			if resumed {
				result.Outcome = "removed"
			} else {
				result.Outcome = "no-op"
				result.InvalidationPaths = nil
			}
			result.Changes = uniqueChanges(result.Changes)
			result.FilesRemoved = countRemovedChanges(result.Changes)
			return nil
		}
		if err := validateInvalidation(backend, plan.journal.Paths); err != nil {
			return err
		}
		if _, err := writePreviewCleanup(lockedContext, conditional, plan.journal); err != nil {
			return err
		}
		invalidationID, err := applyPreviewCleanup(lockedContext, backend, store, plan.journal)
		if err != nil {
			return err
		}
		appendPreviewCleanupChanges(&result, plan.journal)
		result.Changes = uniqueChanges(result.Changes)
		result.InvalidationPaths = uniqueSorted(result.InvalidationPaths)
		result.FilesRemoved = countRemovedChanges(result.Changes)
		result.InvalidationID = invalidationID
		result.Outcome = "removed"
		return nil
	})
	if err != nil {
		return result, err
	}
	return result, nil
}

func pendingPreviewCleanupError(siteID, groupID string) error {
	return fmt.Errorf("preview site %q has pending cleanup for group %q; retry `artifact-pages preview remove --site %s --group %s` first", siteID, groupID, siteID, groupID)
}

func previewRemoveResult(options PreviewRemoveOptions) Result {
	return Result{Operation: "preview remove", Site: options.SiteID, GroupID: options.GroupID, Changes: []Change{}}
}

func previewRemovalDependencies(ctx context.Context, backend DeploymentBackend, options PreviewRemoveOptions) (ConditionalObjectBackend, *ObjectPreviewStore, error) {
	if ctx == nil {
		return nil, nil, errors.New("preview removal context is required")
	}
	if backend == nil {
		return nil, nil, errors.New("deployment backend is required")
	}
	if err := validateLockSite(options.SiteID); err != nil {
		return nil, nil, err
	}
	if err := preview.ValidateGroupID(options.GroupID); err != nil {
		return nil, nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		return nil, nil, errors.New("deployment backend does not support origin reads and conditional writes")
	}
	store, err := NewObjectPreviewStore(conditional)
	if err != nil {
		return nil, nil, err
	}
	return conditional, store, nil
}

func planPreviewRemoval(ctx context.Context, backend DeploymentBackend, store *ObjectPreviewStore, siteID, groupID string, catalog preview.Catalog) (previewRemovalPlan, error) {
	plan := previewRemovalPlan{journal: previewCleanupRecord{
		SchemaVersion: previewCleanupSchema, Site: siteID, GroupID: groupID,
		Revisions: []preview.RevisionOwnership{}, ObjectKeys: []string{}, Paths: []string{},
	}}
	if err := preview.ValidateGroupID(groupID); err != nil {
		return plan, err
	}
	if err := preview.ValidateCatalog(catalog); err != nil {
		return plan, fmt.Errorf("existing preview catalog is invalid: %w", err)
	}
	if catalog.Site != siteID {
		return plan, fmt.Errorf("preview catalog site %q does not match %q", catalog.Site, siteID)
	}
	var selected *preview.GroupRevisionHistory
	for index := range catalog.RevisionHistory {
		if catalog.RevisionHistory[index].GroupID == groupID {
			selected = &catalog.RevisionHistory[index]
			break
		}
	}
	if selected == nil {
		return plan, nil
	}
	plan.hasGroup = true
	otherOwners := make(map[string]struct{})
	for _, history := range catalog.RevisionHistory {
		if history.GroupID == groupID {
			continue
		}
		for _, revision := range history.Revisions {
			otherOwners[revision.HeadSHA] = struct{}{}
		}
	}
	for _, revision := range selected.Revisions {
		if _, shared := otherOwners[revision.HeadSHA]; shared {
			continue
		}
		if err := verifyOwnedRevisionManifest(ctx, store, siteID, revision); err != nil {
			return previewRemovalPlan{}, err
		}
		plan.journal.Revisions = append(plan.journal.Revisions, revision)
	}
	keys, paths, err := previewCleanupKeysAndPaths(siteID, plan.journal.Revisions)
	if err != nil {
		return previewRemovalPlan{}, err
	}
	listedKeys, err := listPreviewRevisionKeys(ctx, backend, siteID, plan.journal.Revisions)
	if err != nil {
		return previewRemovalPlan{}, err
	}
	plan.journal.ObjectKeys = uniqueSorted(append(keys, listedKeys...))
	plan.journal.Paths = paths
	if err := validatePreviewCleanupRecord(plan.journal); err != nil {
		return previewRemovalPlan{}, err
	}
	if len(keys) > previewCleanupPathLimit {
		return previewRemovalPlan{}, fmt.Errorf("preview removal requires %d exact object keys; limit is %d", len(keys), previewCleanupPathLimit)
	}
	if err := validateInvalidation(backend, paths); err != nil {
		return previewRemovalPlan{}, err
	}
	return plan, nil
}

func verifyOwnedRevisionManifest(ctx context.Context, store *ObjectPreviewStore, siteID string, ownership preview.RevisionOwnership) error {
	key, err := preview.ManifestKey(siteID, ownership.HeadSHA)
	if err != nil {
		return err
	}
	contents, err := store.ReadObject(ctx, key)
	if errors.Is(err, preview.ErrObjectNotFound) {
		// Provider retention may have removed the immutable manifest. The
		// catalog ownership ledger remains the exact deletion authority.
		return nil
	}
	if err != nil {
		return fmt.Errorf("read preview manifest for %s: %w", ownership.HeadSHA, err)
	}
	manifest, err := preview.DecodeManifest(contents)
	if err != nil {
		return fmt.Errorf("preview manifest for %s is invalid: %w", ownership.HeadSHA, err)
	}
	if manifest.Site != siteID || manifest.HeadSHA != ownership.HeadSHA {
		return fmt.Errorf("preview manifest for %s does not match its ownership record", ownership.HeadSHA)
	}
	files := make([]string, 0, len(manifest.Files))
	for _, file := range manifest.Files {
		files = append(files, file.Path)
	}
	sort.Strings(files)
	if !sameStringSlice(files, ownership.Files) {
		return fmt.Errorf("preview manifest for %s does not match its exact ownership file list", ownership.HeadSHA)
	}
	return nil
}

func readPreviewCatalog(ctx context.Context, store *ObjectPreviewStore, siteID string) (preview.Catalog, error) {
	key, err := preview.CatalogKey(siteID)
	if err != nil {
		return preview.Catalog{}, err
	}
	contents, err := store.ReadObject(ctx, key)
	if errors.Is(err, preview.ErrObjectNotFound) {
		return preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: siteID, Groups: []preview.Group{}, RevisionHistory: []preview.GroupRevisionHistory{}}, nil
	}
	if err != nil {
		return preview.Catalog{}, fmt.Errorf("read preview catalog: %w", err)
	}
	catalog, err := preview.DecodeCatalog(contents)
	if err != nil {
		return preview.Catalog{}, fmt.Errorf("existing preview catalog is invalid: %w", err)
	}
	if catalog.Site != siteID {
		return preview.Catalog{}, fmt.Errorf("preview catalog site %q does not match %q", catalog.Site, siteID)
	}
	return catalog, nil
}

func removeCatalogGroup(catalog preview.Catalog, groupID string) preview.Catalog {
	groups := make([]preview.Group, 0, len(catalog.Groups))
	for _, group := range catalog.Groups {
		if group.ID != groupID {
			groups = append(groups, group)
		}
	}
	catalog.Groups = groups
	histories := make([]preview.GroupRevisionHistory, 0, len(catalog.RevisionHistory))
	for _, history := range catalog.RevisionHistory {
		if history.GroupID != groupID {
			histories = append(histories, history)
		}
	}
	catalog.RevisionHistory = histories
	return catalog
}

func previewCleanupKeysAndPaths(siteID string, revisions []preview.RevisionOwnership) ([]string, []string, error) {
	keys := make([]string, 0)
	// Cache invalidation is deliberately scoped to one site's preview cache.
	// It may evict sibling previews from edge caches, but it never deletes
	// sibling origin objects and avoids provider quotas tied to revision count.
	paths := []string{"/_previews/" + siteID + "/*"}
	for _, revision := range revisions {
		manifest, err := preview.ManifestKey(siteID, revision.HeadSHA)
		if err != nil {
			return nil, nil, err
		}
		manifestRaw, err := preview.RawObjectKey(manifest)
		if err != nil {
			return nil, nil, err
		}
		keys = append(keys, manifestRaw)
		for _, file := range revision.Files {
			fileKey, err := preview.FileKey(siteID, revision.HeadSHA, file)
			if err != nil {
				return nil, nil, err
			}
			raw, err := preview.RawObjectKey(fileKey)
			if err != nil {
				return nil, nil, err
			}
			keys = append(keys, raw)
		}
	}
	sort.Strings(keys)
	keys = uniqueSorted(keys)
	paths = uniqueSorted(paths)
	return keys, paths, nil
}

func listPreviewRevisionKeys(ctx context.Context, backend DeploymentBackend, siteID string, revisions []preview.RevisionOwnership) ([]string, error) {
	keys := make([]string, 0)
	for _, revision := range revisions {
		prefix := "_previews/" + siteID + "/revisions/" + revision.HeadSHA + "/"
		listed, err := backend.ListKeys(ctx, prefix)
		if err != nil {
			return nil, fmt.Errorf("list exact preview revision %s for removal: %w", revision.HeadSHA, err)
		}
		for _, key := range listed {
			if !strings.HasPrefix(key, prefix) {
				return nil, fmt.Errorf("preview revision listing for %s returned out-of-scope key %q", revision.HeadSHA, key)
			}
			if err := validatePreviewRevisionObjectKey(siteID, revision.HeadSHA, key); err != nil {
				return nil, err
			}
			keys = append(keys, key)
		}
	}
	return uniqueSorted(keys), nil
}

func validatePreviewRevisionObjectKey(siteID, headSHA, key string) error {
	prefix := "_previews/" + siteID + "/revisions/" + headSHA + "/"
	if !strings.HasPrefix(key, prefix) {
		return fmt.Errorf("preview revision object %q is outside its selected SHA prefix", key)
	}
	suffix := strings.TrimPrefix(key, prefix)
	if suffix == "manifest.json" {
		return nil
	}
	if !strings.HasPrefix(suffix, "files/") || len(suffix) == len("files/") {
		return fmt.Errorf("preview revision listing returned unsupported object %q", key)
	}
	canonical, err := preview.FileKey(siteID, headSHA, strings.TrimPrefix(suffix, "files/"))
	if err != nil {
		return fmt.Errorf("preview revision listing returned invalid file key %q: %w", key, err)
	}
	raw, err := preview.RawObjectKey(canonical)
	if err != nil || raw != key {
		return fmt.Errorf("preview revision listing returned non-canonical file key %q", key)
	}
	return nil
}

func readPreviewCleanup(ctx context.Context, backend ConditionalObjectBackend, siteID string) (*previewCleanupRecord, string, error) {
	object, etag, err := getSiteControl(ctx, backend, siteID, previewCleanupKey(siteID))
	if errors.Is(err, ErrObjectNotFound) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", fmt.Errorf("read preview cleanup journal for %q: %w", siteID, err)
	}
	if strings.TrimSpace(etag) == "" {
		return nil, "", errors.New("preview cleanup journal has no ETag")
	}
	if len(object.Bytes) > maxPreviewCleanupBytes {
		return nil, "", fmt.Errorf("preview cleanup journal exceeds %d bytes", maxPreviewCleanupBytes)
	}
	if err := validateNoDuplicateJSONKeys(object.Bytes); err != nil {
		return nil, "", fmt.Errorf("validate preview cleanup journal: %w", err)
	}
	if err := compat.CheckSchemaVersion("preview cleanup journal", object.Bytes, previewCleanupSchema); err != nil {
		return nil, "", err
	}
	decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
	decoder.DisallowUnknownFields()
	var record previewCleanupRecord
	if err := decoder.Decode(&record); err != nil {
		return nil, "", fmt.Errorf("decode preview cleanup journal: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, "", errors.New("preview cleanup journal must contain exactly one JSON value")
	}
	if err := validatePreviewCleanupRecord(record); err != nil {
		return nil, "", err
	}
	if record.Site != siteID {
		return nil, "", fmt.Errorf("preview cleanup journal site %q does not match %q", record.Site, siteID)
	}
	return &record, etag, nil
}

func validatePreviewCleanupRecord(record previewCleanupRecord) error {
	if record.SchemaVersion != previewCleanupSchema || record.Revisions == nil || record.ObjectKeys == nil || record.Paths == nil {
		return errors.New("preview cleanup journal requires schemaVersion and revision, object, and path arrays")
	}
	if err := validateLockSite(record.Site); err != nil {
		return fmt.Errorf("preview cleanup journal has invalid site: %w", err)
	}
	if err := preview.ValidateGroupID(record.GroupID); err != nil {
		return fmt.Errorf("preview cleanup journal has invalid group: %w", err)
	}
	for index, revision := range record.Revisions {
		if index > 0 && record.Revisions[index-1].HeadSHA >= revision.HeadSHA {
			return errors.New("preview cleanup journal revisions must be unique and sorted by SHA")
		}
		if revision.Files == nil {
			return fmt.Errorf("preview cleanup journal revision %q has no file array", revision.HeadSHA)
		}
		for fileIndex, file := range revision.Files {
			if fileIndex > 0 && revision.Files[fileIndex-1] >= file {
				return fmt.Errorf("preview cleanup journal revision %q files must be unique and sorted", revision.HeadSHA)
			}
			if _, err := preview.FileKey(record.Site, revision.HeadSHA, file); err != nil {
				return fmt.Errorf("preview cleanup journal contains an invalid owned file: %w", err)
			}
		}
	}
	requiredKeys, expectedPaths, err := previewCleanupKeysAndPaths(record.Site, record.Revisions)
	if err != nil {
		return err
	}
	if !sort.StringsAreSorted(record.ObjectKeys) {
		return errors.New("preview cleanup journal object keys must be sorted")
	}
	for index, key := range record.ObjectKeys {
		if index > 0 && record.ObjectKeys[index-1] == key {
			return errors.New("preview cleanup journal object keys must be unique")
		}
		matched := false
		for _, revision := range record.Revisions {
			if err := validatePreviewRevisionObjectKey(record.Site, revision.HeadSHA, key); err == nil {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("preview cleanup journal contains an object outside its exact revision scopes: %q", key)
		}
	}
	keySet := make(map[string]struct{}, len(record.ObjectKeys))
	for _, key := range record.ObjectKeys {
		keySet[key] = struct{}{}
	}
	for _, key := range requiredKeys {
		if _, ok := keySet[key]; !ok {
			return fmt.Errorf("preview cleanup journal is missing ownership object %q", key)
		}
	}
	if !sameStringSlice(record.Paths, expectedPaths) {
		return errors.New("preview cleanup journal invalidation paths do not match its revision scope")
	}
	if len(record.ObjectKeys) > previewCleanupPathLimit {
		return fmt.Errorf("preview cleanup journal contains more than %d object keys", previewCleanupPathLimit)
	}
	return nil
}

func writePreviewCleanup(ctx context.Context, backend ConditionalObjectBackend, record previewCleanupRecord) (string, error) {
	if err := validatePreviewCleanupRecord(record); err != nil {
		return "", err
	}
	contents, err := json.Marshal(record)
	if err != nil {
		return "", fmt.Errorf("encode preview cleanup journal: %w", err)
	}
	if len(contents) > maxPreviewCleanupBytes {
		return "", fmt.Errorf("preview cleanup journal exceeds %d bytes", maxPreviewCleanupBytes)
	}
	etag, err := backend.PutObjectConditional(ctx, previewCleanupKey(record.Site), Object{
		Bytes: contents, ContentType: "application/json; charset=utf-8", Cache: "no-store",
	}, ObjectCondition{IfNoneMatch: true})
	if err != nil {
		return "", fmt.Errorf("write preview cleanup journal: %w", err)
	}
	if strings.TrimSpace(etag) == "" {
		return "", errors.New("preview cleanup journal write returned no ETag")
	}
	return etag, nil
}

func resumePreviewCleanup(ctx context.Context, backend DeploymentBackend, conditional ConditionalObjectBackend, store *ObjectPreviewStore) (*previewCleanupRecord, bool, error) {
	lock, ok := ctx.Value(previewSiteLockContextKey{}).(previewSiteLock)
	if !ok {
		return nil, false, errors.New("preview cleanup recovery requires an active site lock")
	}
	record, _, err := readPreviewCleanup(ctx, conditional, lock.site)
	if err != nil || record == nil {
		return record, false, err
	}
	if _, err := applyPreviewCleanup(ctx, backend, store, *record); err != nil {
		return record, false, err
	}
	return record, true, nil
}

func applyPreviewCleanup(ctx context.Context, backend DeploymentBackend, store *ObjectPreviewStore, record previewCleanupRecord) (string, error) {
	if err := validatePreviewCleanupRecord(record); err != nil {
		return "", err
	}
	lock, ok := ctx.Value(previewSiteLockContextKey{}).(previewSiteLock)
	if !ok || lock.site != record.Site {
		return "", fmt.Errorf("preview cleanup for site %q requires its active site lock", record.Site)
	}
	if err := validateInvalidation(backend, record.Paths); err != nil {
		return "", err
	}
	catalog, err := readPreviewCatalog(ctx, store, record.Site)
	if err != nil {
		return "", err
	}
	if err := validateJournalHasNoSiblingOwners(catalog, record); err != nil {
		return "", err
	}
	if history := findRevisionHistory(catalog, record.GroupID); history != nil {
		if err := validateJournalMatchesHistory(catalog, record, *history); err != nil {
			return "", err
		}
		catalog = removeCatalogGroup(catalog, record.GroupID)
		catalogKey, err := preview.CatalogKey(record.Site)
		if err != nil {
			return "", err
		}
		catalogBytes, err := preview.EncodeCatalog(catalog)
		if err != nil {
			return "", err
		}
		if err := store.ReplaceMutableObject(ctx, catalogKey, catalogBytes); err != nil {
			return "", fmt.Errorf("remove preview group %q from catalog: %w", record.GroupID, err)
		}
	}
	if len(record.ObjectKeys) > 0 {
		if err := backend.DeleteObjects(ctx, record.ObjectKeys); err != nil {
			return "", fmt.Errorf("preview revisions may be partially removed; retry preview remove: %w", err)
		}
	}
	invalidationID, err := backend.Invalidate(ctx, record.Paths)
	if err != nil {
		return "", fmt.Errorf("preview objects were removed but cache revalidation failed; retry preview remove: %w", err)
	}
	if err := backend.DeleteObjects(ctx, []string{previewCleanupKey(record.Site)}); err != nil {
		return "", fmt.Errorf("preview cleanup completed but its journal could not be cleared; retry preview remove: %w", err)
	}
	return invalidationID, nil
}

func validateJournalHasNoSiblingOwners(catalog preview.Catalog, record previewCleanupRecord) error {
	for _, history := range catalog.RevisionHistory {
		if history.GroupID == record.GroupID {
			continue
		}
		for _, revision := range history.Revisions {
			for _, deleting := range record.Revisions {
				if revision.HeadSHA == deleting.HeadSHA {
					return fmt.Errorf("preview cleanup journal for %q would delete revision %s still owned by sibling group %q", record.GroupID, revision.HeadSHA, history.GroupID)
				}
			}
		}
	}
	return nil
}

func validateJournalMatchesHistory(catalog preview.Catalog, record previewCleanupRecord, selected preview.GroupRevisionHistory) error {
	exclusive := make([]preview.RevisionOwnership, 0, len(selected.Revisions))
	for _, revision := range selected.Revisions {
		shared := false
		for _, sibling := range catalog.RevisionHistory {
			if sibling.GroupID == record.GroupID {
				continue
			}
			for _, owned := range sibling.Revisions {
				if owned.HeadSHA == revision.HeadSHA {
					shared = true
					break
				}
			}
			if shared {
				break
			}
		}
		if !shared {
			exclusive = append(exclusive, revision)
		}
	}
	if len(exclusive) != len(record.Revisions) {
		return fmt.Errorf("preview cleanup journal for %q does not cover its exact exclusive revision set", record.GroupID)
	}
	for index := range exclusive {
		if exclusive[index].HeadSHA != record.Revisions[index].HeadSHA || !sameStringSlice(exclusive[index].Files, record.Revisions[index].Files) {
			return fmt.Errorf("preview cleanup journal for %q differs from its exact exclusive revision set", record.GroupID)
		}
	}
	return validateJournalHasNoSiblingOwners(catalog, record)
}

func findRevisionHistory(catalog preview.Catalog, groupID string) *preview.GroupRevisionHistory {
	for index := range catalog.RevisionHistory {
		if catalog.RevisionHistory[index].GroupID == groupID {
			return &catalog.RevisionHistory[index]
		}
	}
	return nil
}

func appendPreviewCleanupChanges(result *Result, record previewCleanupRecord) {
	catalogKey, _ := preview.CatalogKey(record.Site)
	result.Changes = append(result.Changes, Change{Action: "update", Path: catalogKey})
	for _, key := range record.ObjectKeys {
		result.Changes = append(result.Changes, Change{Action: "remove", Path: key})
	}
	for _, path := range record.Paths {
		result.Changes = append(result.Changes, Change{Action: "invalidate", Path: path})
	}
	result.InvalidationPaths = append(result.InvalidationPaths, record.Paths...)
}

func countRemovedChanges(changes []Change) int {
	count := 0
	for _, change := range changes {
		if change.Action == "remove" {
			count++
		}
	}
	return count
}
