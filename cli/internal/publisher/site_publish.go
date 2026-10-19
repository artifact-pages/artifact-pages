package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

type Change struct {
	Action string `json:"action"`
	Path   string `json:"path"`
}

// SiteNotRegisteredError preserves the deployed registry context for CLI guidance.
type SiteNotRegisteredError struct {
	Site            string
	RegisteredSites []string
}

func (err *SiteNotRegisteredError) Error() string {
	return fmt.Sprintf("site %q is not registered in the deployed registry", err.Site)
}

func siteNotRegistered(projection registry.Projection, siteID string) error {
	ids := make([]string, 0, len(projection.Sites))
	for _, site := range projection.Sites {
		ids = append(ids, site.ID)
	}
	sort.Strings(ids)
	return &SiteNotRegisteredError{Site: siteID, RegisteredSites: ids}
}

type desiredSiteObject struct {
	key        string
	relative   string
	sourcePath string
	data       []byte
	digest     string
	object     Object
}

// PublishSite reconciles one explicitly selected registered site's static
// projection. Local, AWS, and Cloudflare implementations share this flow;
// only ConditionalObjectBackend translates the underlying provider semantics.
func PublishSite(ctx context.Context, backend DeploymentBackend, options SitePublishOptions) (Result, error) {
	if backend == nil {
		return Result{}, errors.New("deployment backend is required")
	}
	if options.SiteID == "" {
		return Result{}, errors.New("site identifier is required")
	}
	if err := validateLockSite(options.SiteID); err != nil {
		return Result{}, err
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		return Result{}, errors.New("deployment backend does not support origin reads and conditional writes")
	}
	if err := checkWriter(ctx, conditional, compatCurrentWrites()); err != nil {
		return Result{}, err
	}
	record, err := prepareWriterRecord(ctx, conditional, siteVersionsKey(options.SiteID), writerFormats("site-metadata", "artifact-index", "full-text-manifest"))
	if err != nil {
		return Result{}, err
	}
	previewStore, err := NewObjectPreviewStore(conditional)
	if err != nil {
		return Result{}, err
	}
	_, _, root, err := indexer.ResolveGitRepositoryIdentity(ctx)
	if err != nil {
		return Result{}, err
	}
	if err := preflightLocalSourceBoundary(ctx, conditional, options.SiteID, root, options.SourceDir); err != nil {
		return Result{}, err
	}
	operationCtx := ctx
	var release func() error
	if !options.DryRun {
		var lock LockSnapshot
		lock, release, err = (SiteLockManager{Backend: conditional}).Acquire(ctx, options.SiteID)
		if err != nil {
			return Result{}, err
		}
		operationCtx = context.WithValue(ctx, previewSiteLockContextKey{}, previewSiteLock{
			site: lock.Site, owner: lock.Owner, etag: lock.ETag,
		})
	}
	operation := func() (Result, error) {
		record, err = prepareWriterRecord(ctx, conditional, siteVersionsKey(options.SiteID), writerFormats("site-metadata", "artifact-index", "full-text-manifest"))
		if err != nil {
			return Result{}, err
		}
		if err := checkWriter(ctx, conditional, compatCurrentWrites()); err != nil {
			return Result{}, err
		}
		projection, err := loadOriginRegistry(operationCtx, conditional)
		if err != nil {
			return Result{}, err
		}
		entry, ok := registrySite(projection, options.SiteID)
		if !ok {
			return Result{}, siteNotRegistered(projection, options.SiteID)
		}
		sourceDir := options.SourceDir
		if sourceDir == "" {
			sourceDir = filepath.Join(root, filepath.FromSlash(entry.SourcePath))
		}
		identity, err := indexer.ResolveGitSourceIdentity(operationCtx, sourceDir)
		if err != nil {
			return Result{}, err
		}
		if !strings.EqualFold(identity.Repository, entry.Repository) || identity.SourcePath != entry.SourcePath {
			return Result{}, fmt.Errorf("site %q is registered to %s:%s; selected checkout is %s:%s", options.SiteID, entry.Repository, entry.SourcePath, identity.Repository, identity.SourcePath)
		}
		if err := rejectLocalSourceOverlap(conditional, sourceDir); err != nil {
			return Result{}, err
		}
		preparedOptions := sitePublishBuildOptions(options.SiteID, entry.Name, entry.Description, sourceDir, options.Ref, identity, conditional)
		if options.nowForTest != nil {
			preparedOptions.Now = options.nowForTest
		}
		preparedOptions.DeferGitHubEnrichment = true
		priorObjects := make(map[string]Object)
		priorLoader := sitePriorStateLoaderWithCache(conditional, options.SiteID, priorObjects)
		var preparedPrior *indexer.PriorSiteState
		priorLoaded := false
		preparedOptions.PriorState = func(ctx context.Context) (*indexer.PriorSiteState, error) {
			if !priorLoaded {
				var loadErr error
				preparedPrior, loadErr = priorLoader(ctx)
				if loadErr != nil {
					return nil, loadErr
				}
				priorLoaded = true
			}
			return preparedPrior, nil
		}
		prepared, err := indexer.PrepareBuild(operationCtx, preparedOptions)
		if err != nil {
			return Result{}, fmt.Errorf("prepare site publish inputs: %w", err)
		}
		// Read the durable cache/transaction journal before examining the state
		// fingerprint. Its generation binding decides whether touched keys must
		// be replayed, and a completed transaction may still need invalidation.
		pending, pendingETag, err := readSiteCacheRetry(operationCtx, conditional, options.SiteID)
		if err != nil {
			return Result{}, err
		}
		snapshot, err := loadSitePublishSnapshot(operationCtx, conditional, options.SiteID, prepared, options.Reconcile, pending, pendingETag)
		if err != nil {
			return Result{}, err
		}
		if !snapshot.fastPath {
			snapshot.priorObjects = priorObjects
			if prepared.NeedsGitHubAssociation() && !priorLoaded {
				preparedPrior, err = loadPriorSiteIndex(operationCtx, conditional, options.SiteID, snapshot.state, snapshot.priorObjects)
				if err != nil {
					return Result{}, fmt.Errorf("read deployed site index for attribution: %w", err)
				}
				priorLoaded = true
			}
			if err := prepared.EnrichGitHub(operationCtx, preparedPrior); err != nil {
				return Result{}, fmt.Errorf("enrich site attribution: %w", err)
			}
		}
		diff, err := buildSitePublishDiff(operationCtx, conditional, options.SiteID, prepared, snapshot, options.Reconcile)
		if err != nil {
			return Result{}, err
		}
		emptyPreviewChanges := []preview.CatalogReconciliationChange{}
		result := Result{
			Operation: "site sync", Site: options.SiteID, Changes: diff.changes,
			PreviewChanges: &emptyPreviewChanges, BuildSkipped: diff.buildSkipped,
			AttributionWarning: prepared.AttributionWarning(),
		}
		if len(diff.snippetTruncated) > 0 || len(diff.snippetOmitted) > 0 {
			result.SnippetLimits = &SnippetLimitsReport{
				TruncatedDocuments: append([]string{}, diff.snippetTruncated...),
				OmittedDocuments:   append([]string{}, diff.snippetOmitted...),
			}
		}
		legacyControl := LegacyControl{}
		if snapshot.legacyRebuild {
			legacyControl.PublishState = &LegacyControlRecord{Detail: snapshot.legacyDetail, BackupKey: snapshot.legacyBackupKey}
		}
		if pending.legacyRecord {
			legacyControl.CacheRetry = &LegacyControlRecord{Detail: pending.legacyDetail, BackupKey: pending.legacyBackupKey}
		}
		if legacyControl.PublishState != nil || legacyControl.CacheRetry != nil {
			result.LegacyControl = &legacyControl
		}
		if !options.DryRun {
			if snapshot.legacyRebuild {
				if err := writeSiteControlLegacyBackup(operationCtx, conditional, "publish-state", snapshot.legacyBackupKey, snapshot.legacyObject); err != nil {
					return result, err
				}
			}
			if pending.legacyRecord {
				if err := writeSiteControlLegacyBackup(operationCtx, conditional, "cache-retry record", pending.legacyBackupKey, pending.legacyObject); err != nil {
					return result, err
				}
			}
			// A pending preview-cleanup journal can mutate projection objects. Save
			// any legacy site controls before resuming that work.
			if _, _, err := resumePreviewCleanup(operationCtx, backend, conditional, previewStore); err != nil {
				return result, err
			}
		}
		var previewPlan preview.CatalogReconciliationPlan
		if options.DryRun {
			previewPlan, err = preview.PlanCatalogReconciliation(operationCtx, previewStore, options.SiteID)
		} else {
			previewPlan, err = preview.PlanCatalogReconciliationUnderSiteLock(operationCtx, previewStore, options.SiteID)
		}
		if err != nil {
			return result, fmt.Errorf("plan preview catalog reconciliation: %w", err)
		}
		result.PreviewChanges = &previewPlan.Changes
		paths := siteCachePaths(options.SiteID, diff.changes, result.PreviewChanges, pending.Paths)
		result.InvalidationPaths = plannedInvalidationPaths(backend, paths)
		if options.DryRun {
			result.FilesPublished = countChanges(diff.changes, "create") + countChanges(diff.changes, "update")
			result.FilesRemoved = countChanges(diff.changes, "remove")
			if len(paths) == 0 {
				result.Outcome = "no-op"
			} else {
				result.Outcome = "planned"
			}
			return result, nil
		}
		if err := validateInvalidation(backend, paths); err != nil {
			return result, err
		}
		if err := stageVersionRecord(operationCtx, conditional, siteVersionsKey(options.SiteID), record, writerFormats("site-metadata", "artifact-index", "full-text-manifest")); err != nil {
			return result, err
		}
		// Persist the transaction id and monotone touched-key union before the
		// first origin mutation. The old state remains the commit point until
		// every projection write/delete has completed.
		var retryNext siteCacheRetry
		writeRetry := false
		if len(paths) > 0 {
			retryNext = siteCacheRetry{SchemaVersion: siteCacheRetrySchemaVersion, Site: options.SiteID, Paths: paths, Transaction: diff.transaction}
			if retryNext.Transaction == nil && pending.Transaction != nil {
				// Keep a completed generation marker while its cache work remains.
				retryNext.Transaction = pending.Transaction
			}
			writeRetry = pending.legacyRecord || siteCacheRetryNeedsWrite(pending, retryNext, pendingETag != "")
			if writeRetry {
				pendingETag, err = writeSiteCacheRetryRecord(operationCtx, conditional, options.SiteID, retryNext, pendingETag)
				if err != nil {
					return result, err
				}
			}
		}
		filesPublished, filesRemoved := 0, 0
		if len(diff.changes) > 0 {
			filesPublished, filesRemoved, err = applySitePlan(operationCtx, backend, diff.desired, diff.changes, diff.stale)
			if err != nil {
				return result, err
			}
		}
		if diff.needsCommit {
			if _, err := writeSitePublishState(operationCtx, conditional, options.SiteID, diff.committedNext, diff.stateExists, diff.stateETag); err != nil {
				return result, fmt.Errorf("commit site publish state after origin projection: %w", err)
			}
		}
		if err := preview.ApplyCatalogReconciliationUnderSiteLock(operationCtx, previewStore, options.SiteID, previewPlan); err != nil {
			return result, fmt.Errorf("production projection is committed but preview catalog reconciliation failed: %w", err)
		}
		if err := writeVersionRecord(operationCtx, backend, siteVersionsKey(options.SiteID), record); err != nil {
			return result, err
		}
		if len(paths) == 0 {
			result.Outcome = "no-op"
			return result, nil
		}
		result.InvalidationID, err = backend.Invalidate(operationCtx, paths)
		if err != nil {
			return result, fmt.Errorf("site origin synchronized but cache revalidation failed; retry site publish: %w", err)
		}
		if err := backend.DeleteObjects(operationCtx, []string{siteCacheRetryKey(options.SiteID)}); err != nil {
			return result, fmt.Errorf("site synchronized and cache revalidation requested; clear cache retry record: %w", err)
		}
		result.Outcome, result.FilesPublished, result.FilesRemoved = "synced", filesPublished, filesRemoved
		return result, nil
	}
	result, operationErr := operation()
	if release != nil {
		releaseErr := release()
		if operationErr == nil && releaseErr != nil {
			operationErr = fmt.Errorf("site operation completed but lock release failed: %w", releaseErr)
		} else if operationErr != nil && releaseErr != nil {
			operationErr = errors.Join(operationErr, fmt.Errorf("release site lock: %w", releaseErr))
		}
	}
	if operationErr != nil {
		return result, operationErr
	}
	return result, nil
}

func rejectLocalSourceOverlap(backend ConditionalObjectBackend, sourceDir string) error {
	localBackend, ok := backend.(localStorageRoot)
	if !ok {
		return nil
	}
	return rejectOverlappingLocalSource(localBackend.localStorageRoot(), sourceDir)
}

func countPreviewChanges(changes *[]preview.CatalogReconciliationChange, action string) int {
	if changes == nil {
		return 0
	}
	count := 0
	for _, change := range *changes {
		if change.Action == action {
			count++
		}
	}
	return count
}

func loadOriginRegistry(ctx context.Context, backend ConditionalObjectBackend) (registry.Projection, error) {
	object, _, err := backend.GetObject(ctx, "_indexes/sites.json")
	if errors.Is(err, ErrObjectNotFound) {
		return registry.Projection{}, errors.New("deployed site registry _indexes/sites.json is missing")
	}
	if err != nil {
		return registry.Projection{}, fmt.Errorf("read deployed site registry: %w", err)
	}
	projection, err := registry.DecodeProjection(object.Bytes)
	if err != nil {
		return registry.Projection{}, fmt.Errorf("validate deployed site registry: %w", err)
	}
	return projection, nil
}

func registrySite(projection registry.Projection, siteID string) (registry.Entry, bool) {
	for _, entry := range projection.Sites {
		if entry.ID == siteID {
			return entry, true
		}
	}
	return registry.Entry{}, false
}

func sameGeneratedProjection(current, desired []byte) bool {
	var currentValue map[string]any
	var desiredValue map[string]any
	if json.Unmarshal(current, &currentValue) != nil || json.Unmarshal(desired, &desiredValue) != nil {
		return false
	}
	delete(currentValue, "generatedAt")
	delete(desiredValue, "generatedAt")
	currentJSON, currentErr := json.Marshal(currentValue)
	desiredJSON, desiredErr := json.Marshal(desiredValue)
	return currentErr == nil && desiredErr == nil && string(currentJSON) == string(desiredJSON)
}

type ChangeAction string

func countChanges(changes []Change, action string) int {
	count := 0
	for _, change := range changes {
		if change.Action == action {
			count++
		}
	}
	return count
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
