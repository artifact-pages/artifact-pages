package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
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
		plan, stale, desired, err := buildSitePlan(operationCtx, conditional, options.SiteID, entry.Name, entry.Description, sourceDir, identity)
		if err != nil {
			return Result{}, err
		}
		emptyPreviewChanges := []preview.CatalogReconciliationChange{}
		result := Result{Operation: "site publish", Site: options.SiteID, Changes: plan, PreviewChanges: &emptyPreviewChanges}
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
		if options.DryRun {
			result.FilesPublished = countChanges(plan, "create") + countChanges(plan, "update")
			result.FilesRemoved = countChanges(plan, "remove")
			if len(plan) == 0 && countPreviewChanges(result.PreviewChanges, "remove") == 0 {
				result.Outcome = "no-op"
			} else {
				result.Outcome = "planned"
			}
			return result, nil
		}
		filesPublished, filesRemoved := 0, 0
		if len(plan) > 0 {
			filesPublished, filesRemoved, err = applySitePlan(operationCtx, backend, desired, plan, stale)
			if err != nil {
				return result, err
			}
		}
		if err := preview.ApplyCatalogReconciliationUnderSiteLock(operationCtx, previewStore, options.SiteID, previewPlan); err != nil {
			return result, fmt.Errorf("production projection is committed but preview catalog reconciliation failed: %w", err)
		}
		if len(plan) == 0 && countPreviewChanges(result.PreviewChanges, "remove") == 0 {
			result.Outcome = "no-op"
			return result, nil
		}
		result.Outcome, result.FilesPublished, result.FilesRemoved = "published", filesPublished, filesRemoved
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

func buildSitePlan(ctx context.Context, backend ConditionalObjectBackend, siteID, title, description, sourceDir string, identity indexer.GitSourceIdentity) ([]Change, []string, []desiredSiteObject, error) {
	artifactPrefix := "_artifacts/" + siteID + "/"
	indexPrefix := "_indexes/" + siteID + "/"
	artifacts, err := collectSiteArtifacts(sourceDir, artifactPrefix, siteID)
	if err != nil {
		return nil, nil, nil, err
	}
	buildDir, err := os.MkdirTemp("", "artifact-pages-site-build-")
	if err != nil {
		return nil, nil, nil, fmt.Errorf("create temporary site build directory: %w", err)
	}
	defer os.RemoveAll(buildDir)
	build, err := indexer.Build(ctx, indexer.BuildOptions{
		SiteID: siteID, SiteTitle: title, SiteDescription: description, SourceDir: sourceDir, OutputDir: buildDir,
		Repository: identity.Repository, RepositoryURL: identity.RepositoryURL,
	})
	if err != nil {
		return nil, nil, nil, fmt.Errorf("build site index: %w", err)
	}
	if err := verifySiteArtifactSnapshot(sourceDir, artifactPrefix, siteID, artifacts); err != nil {
		return nil, nil, nil, err
	}
	oldArtifacts, err := backend.ListKeys(ctx, artifactPrefix)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("list deployed site artifacts: %w", err)
	}
	if _, err := backend.ListKeys(ctx, indexPrefix); err != nil {
		return nil, nil, nil, fmt.Errorf("list deployed site index objects: %w", err)
	}
	changes := make([]Change, 0)
	keep := make(map[string]struct{}, len(artifacts))
	sourceArtifactCount := len(artifacts)
	artifactChanged := false
	for _, desired := range artifacts {
		keep[desired.key] = struct{}{}
		info, headErr := backend.HeadObject(ctx, desired.key)
		if errors.Is(headErr, ErrObjectNotFound) {
			changes = append(changes, Change{Action: "create", Path: desired.key})
			artifactChanged = true
			continue
		}
		if headErr != nil {
			return nil, nil, nil, fmt.Errorf("inspect deployed object %s: %w", desired.key, headErr)
		}
		if !siteObjectMetadataMatches(info, desired) {
			changes = append(changes, Change{Action: "update", Path: desired.key})
			artifactChanged = true
		}
	}
	stale := make([]string, 0)
	for _, key := range oldArtifacts {
		if _, exists := keep[key]; !exists {
			stale = append(stale, key)
			changes = append(changes, Change{Action: "remove", Path: key})
		}
	}
	for _, generated := range []struct{ path, name string }{{build.OutputPath, "index.json"}, {build.MetadataPath, "meta.json"}} {
		data, err := os.ReadFile(generated.path)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("read generated site %s: %w", generated.name, err)
		}
		key := indexPrefix + generated.name
		if !artifactChanged {
			current, _, readErr := backend.GetObject(ctx, key)
			if readErr == nil && sameGeneratedProjection(current.Bytes, data) {
				data = current.Bytes
			} else if readErr != nil && !errors.Is(readErr, ErrObjectNotFound) {
				return nil, nil, nil, fmt.Errorf("read deployed site %s: %w", generated.name, readErr)
			}
		}
		artifacts = append(artifacts, desiredSiteObject{
			key: key, relative: generated.name, data: data,
			digest: sha256Hex(data), object: Object{
				ContentType: "application/json; charset=utf-8", ContentDisposition: "inline",
				Cache: indexCacheControl, Metadata: map[string]string{"artifact-pages-site": siteID},
			},
		})
	}
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].key < artifacts[j].key })
	for _, desired := range artifacts[sourceArtifactCount:] {
		info, headErr := backend.HeadObject(ctx, desired.key)
		if errors.Is(headErr, ErrObjectNotFound) {
			changes = append(changes, Change{Action: "create", Path: desired.key})
			continue
		}
		if headErr != nil {
			return nil, nil, nil, fmt.Errorf("inspect deployed object %s: %w", desired.key, headErr)
		}
		if !siteObjectMetadataMatches(info, desired) {
			changes = append(changes, Change{Action: "update", Path: desired.key})
		}
	}
	sort.Strings(stale)
	sort.Slice(changes, func(i, j int) bool {
		if changes[i].Path == changes[j].Path {
			return changes[i].Action < changes[j].Action
		}
		return changes[i].Path < changes[j].Path
	})
	return changes, stale, artifacts, nil
}

func siteObjectMetadataMatches(info ObjectInfo, desired desiredSiteObject) bool {
	if info.Metadata["artifact-pages-sha256"] != desired.digest ||
		info.ContentType != desired.object.ContentType || info.ContentEncoding != desired.object.ContentEncoding ||
		info.CacheControl != desired.object.Cache {
		return false
	}
	if info.ContentDisposition == desired.object.ContentDisposition {
		return true
	}
	// An omitted disposition has the same browser behavior as inline.
	return info.ContentDisposition == "" && desired.object.ContentDisposition == "inline"
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

func collectSiteArtifacts(root, prefix, siteID string) ([]desiredSiteObject, error) {
	desired := make([]desiredSiteObject, 0)
	err := filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Name() == ".git" {
			if entry.Type()&os.ModeSymlink != 0 || (!entry.IsDir() && !entry.Type().IsRegular()) {
				return fmt.Errorf("unsupported filesystem entry in site source: %s", filePath)
			}
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("site source must not contain symbolic links: %s", filePath)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("unsupported filesystem entry in site source: %s", filePath)
		}
		relative, err := filepath.Rel(root, filePath)
		if err != nil {
			return fmt.Errorf("resolve site path %s: %w", filePath, err)
		}
		relative = filepath.ToSlash(relative)
		if err := indexer.ValidateUTF8RelativePath(relative); err != nil {
			return fmt.Errorf("site source %w", err)
		}
		data, err := os.ReadFile(filePath)
		if err != nil {
			return fmt.Errorf("read site file %s: %w", relative, err)
		}
		desired = append(desired, desiredSiteObject{
			key: prefix + relative, relative: relative, sourcePath: filePath,
			digest: sha256Hex(data), object: Object{
				ContentType: contentType(relative), ContentDisposition: "inline", Cache: artifactCacheControl,
				Metadata: map[string]string{"artifact-pages-site": siteID},
			},
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("inspect site source: %w", err)
	}
	sort.Slice(desired, func(i, j int) bool { return desired[i].key < desired[j].key })
	return desired, nil
}

func verifySiteArtifactSnapshot(root, prefix, siteID string, expected []desiredSiteObject) error {
	current, err := collectSiteArtifacts(root, prefix, siteID)
	if err != nil {
		return err
	}
	if len(current) != len(expected) {
		return errors.New("site source changed while preparing publish; retry with a stable working tree")
	}
	for index := range expected {
		if current[index].key != expected[index].key || current[index].digest != expected[index].digest {
			return errors.New("site source changed while preparing publish; retry with a stable working tree")
		}
	}
	return nil
}

func applySitePlan(ctx context.Context, backend DeploymentBackend, desired []desiredSiteObject, changes []Change, stale []string) (int, int, error) {
	changed := make(map[string]ChangeAction, len(changes))
	for _, change := range changes {
		changed[change.Path] = ChangeAction(change.Action)
	}
	filesPublished := 0
	for _, object := range desired {
		if _, shouldPut := changed[object.key]; !shouldPut {
			continue
		}
		data := object.data
		if object.sourcePath != "" {
			contents, err := os.ReadFile(object.sourcePath)
			if err != nil {
				return filesPublished, 0, fmt.Errorf("read site source %s before publish: %w", object.relative, err)
			}
			if sha256Hex(contents) != object.digest {
				return filesPublished, 0, fmt.Errorf("site source %s changed while preparing publish; retry with a stable working tree", object.relative)
			}
			data = contents
		}
		object.object.Bytes = data
		if object.object.Metadata == nil {
			object.object.Metadata = make(map[string]string)
		}
		object.object.Metadata["artifact-pages-sha256"] = object.digest
		if err := backend.PutObject(ctx, object.key, object.object); err != nil {
			return filesPublished, 0, fmt.Errorf("publish %s: %w", object.key, err)
		}
		filesPublished++
	}
	if len(stale) > 0 {
		if err := backend.DeleteObjects(ctx, stale); err != nil {
			return filesPublished, 0, fmt.Errorf("remove stale site objects: %w", err)
		}
	}
	return filesPublished, len(stale), nil
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
