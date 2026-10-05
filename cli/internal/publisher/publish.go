package publisher

import (
	"context"
	"errors"
	"fmt"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

const (
	indexCacheControl    = "public, max-age=0, s-maxage=60, must-revalidate"
	artifactCacheControl = "public, max-age=0, s-maxage=300, must-revalidate"
)

type AppDeployOptions struct {
	ArchivePath string
	Version     string
	Repository  string
	DryRun      bool
}

type SitePublishOptions struct {
	Reconcile bool
	SiteID    string
	SourceDir string
	DryRun    bool
}

type Result struct {
	Operation         string                                 `json:"operation"`
	Outcome           string                                 `json:"outcome"`
	Site              string                                 `json:"site,omitempty"`
	Changes           []Change                               `json:"changes"`
	PreviewChanges    *[]preview.CatalogReconciliationChange `json:"previewChanges,omitempty"`
	RegistryUpdated   *bool                                  `json:"registryUpdated,omitempty"`
	Lock              *LockSnapshot                          `json:"lock,omitempty"`
	Version           string                                 `json:"version,omitempty"`
	FilesPublished    int                                    `json:"filesPublished,omitempty"`
	FilesRemoved      int                                    `json:"filesRemoved,omitempty"`
	InvalidationID    string                                 `json:"invalidationId,omitempty"`
	InvalidationPaths []string                               `json:"invalidationPaths,omitempty"`
	SourceDirty       bool                                   `json:"sourceDirty,omitempty"`
	BuildSkipped      bool                                   `json:"buildSkipped,omitempty"`
}

func DeployApp(ctx context.Context, backend DeploymentBackend, options AppDeployOptions) (Result, error) {
	if backend == nil {
		return Result{}, errors.New("deployment backend is required")
	}
	archivePath, cleanup, err := resolveAppArchive(ctx, options)
	if err != nil {
		return Result{}, err
	}
	if cleanup != nil {
		defer cleanup()
	}
	bundle, err := loadAppBundle(archivePath)
	if err != nil {
		return Result{}, err
	}
	if options.Version != "" && options.Version != bundle.manifest.Version {
		return Result{}, fmt.Errorf("downloaded release version %q does not match this CLI's pinned version %q", bundle.manifest.Version, options.Version)
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		return Result{}, errors.New("deployment backend does not support conditional object reads and writes")
	}
	metadataBackend, ok := backend.(ObjectMetadataBackend)
	if !ok {
		return Result{}, errors.New("deployment backend does not support object metadata reads")
	}

	files := append([]bundleFile(nil), bundle.files...)
	sort.Slice(files, func(i, j int) bool {
		if files[i].path == "index.html" {
			return false
		}
		if files[j].path == "index.html" {
			return true
		}
		return files[i].path < files[j].path
	})
	operation := func() (Result, error) {
		retry, retryETag, err := readAppCacheRetry(ctx, conditional)
		if err != nil {
			return Result{}, err
		}

		changed := make([]bundleFile, 0, len(files))
		plan := make([]Change, 0, len(files))
		for _, file := range files {
			info, err := metadataBackend.HeadObject(ctx, file.path)
			if errors.Is(err, ErrObjectNotFound) {
				changed = append(changed, file)
				plan = append(plan, Change{Action: "create", Path: file.path})
				continue
			}
			if err != nil {
				return Result{}, fmt.Errorf("inspect application object %s: %w", file.path, err)
			}
			if !appObjectMatchesBundle(info, file, bundle.manifest) {
				changed = append(changed, file)
				plan = append(plan, Change{Action: "update", Path: file.path})
			}
		}

		needsInvalidation := len(changed) > 0 || len(retry.Paths) > 0
		invalidationPaths := []string(nil)
		if needsInvalidation {
			invalidationPaths = []string{"/index.html"}
		}
		plannedPaths := plannedInvalidationPaths(backend, invalidationPaths)
		result := Result{
			Operation: "app deploy", Changes: []Change{},
			Version: bundle.manifest.Version, SourceDirty: bundle.manifest.SourceDirty,
		}
		if options.DryRun {
			result.Changes = plan
			result.FilesPublished = len(changed)
			result.InvalidationPaths = plannedPaths
			if needsInvalidation {
				result.Outcome = "planned"
			} else {
				result.Outcome = "no-op"
			}
			return result, nil
		}
		if !needsInvalidation {
			result.Outcome = "no-op"
			return result, nil
		}
		if err := validateInvalidation(backend, invalidationPaths); err != nil {
			return result, err
		}

		// Persist the retry intent before the first application-object write.
		// A response lost after this conditional write leaves a safe cache-only
		// retry for the next invocation.
		journal := retry
		if len(changed) > 0 {
			journal = appCacheRetry{
				SchemaVersion: appCacheRetrySchema, Paths: invalidationPaths,
			}
			if _, err := writeAppCacheRetry(ctx, conditional, journal, retryETag); err != nil {
				return result, err
			}
			for _, file := range changed {
				if err := backend.PutObject(ctx, file.path, Object{
					Bytes: file.data, ContentType: contentType(file.path), Cache: appFileCacheControl(file.path), Metadata: map[string]string{
						"artifact-pages-version":       bundle.manifest.Version,
						"artifact-pages-source-commit": bundle.manifest.SourceCommit,
						"artifact-pages-sha256":        file.sha256,
					},
				}); err != nil {
					return result, fmt.Errorf("publish application object %s: %w", file.path, err)
				}
			}
		}

		invalidationID, err := backend.Invalidate(ctx, invalidationPaths)
		if err != nil {
			return result, fmt.Errorf("application objects may be updated but cache revalidation failed; retry app deploy: %w", err)
		}
		if err := clearAppCacheRetry(ctx, backend); err != nil {
			// DeleteObjects has no compare-and-swap contract, so a reported
			// failure may still have removed the record. Recreate it if absent;
			// an If-None-Match conflict means the retry intent is still present.
			_, restoreErr := writeAppCacheRetry(ctx, conditional, journal, "")
			if errors.Is(restoreErr, ErrPreconditionFailed) {
				restoreErr = nil
			}
			clearErr := fmt.Errorf("application cache was revalidated but its retry record could not be cleared; retry journal retained: %w", err)
			if restoreErr != nil {
				return result, errors.Join(clearErr, fmt.Errorf("restore application cache retry record: %w", restoreErr))
			}
			return result, clearErr
		}
		result.Outcome = "deployed"
		result.FilesPublished = len(changed)
		result.InvalidationID = invalidationID
		result.InvalidationPaths = plannedPaths
		return result, nil
	}

	if options.DryRun {
		return operation()
	}
	_, release, err := (SiteLockManager{Backend: conditional}).AcquireApplication(ctx)
	if err != nil {
		return Result{}, err
	}
	result, operationErr := operation()
	if release != nil {
		releaseErr := release()
		if operationErr == nil && releaseErr != nil {
			operationErr = fmt.Errorf("application deployment completed but lock release failed: %w", releaseErr)
		} else if operationErr != nil && releaseErr != nil {
			operationErr = errors.Join(operationErr, fmt.Errorf("release application lock: %w", releaseErr))
		}
	}
	if operationErr != nil {
		return result, operationErr
	}
	return result, nil
}

func appObjectMatchesBundle(info ObjectInfo, file bundleFile, manifest releaseManifest) bool {
	if info.Size != int64(len(file.data)) || info.Metadata["artifact-pages-sha256"] != file.sha256 ||
		info.ContentType != contentType(file.path) || info.CacheControl != appFileCacheControl(file.path) || info.ContentEncoding != "" ||
		(info.ContentDisposition != "" && info.ContentDisposition != "inline") {
		return false
	}
	// Local directory projections do not persist custom metadata. If a provider
	// returns these provenance fields, however, a different release must refresh
	// them even when its file bytes happen to be identical.
	for key, expected := range map[string]string{
		"artifact-pages-version":       manifest.Version,
		"artifact-pages-source-commit": manifest.SourceCommit,
	} {
		if actual := info.Metadata[key]; actual != "" && actual != expected {
			return false
		}
	}
	return true
}

func appFileCacheControl(relative string) string {
	assetPath := filepath.ToSlash(relative)
	if strings.HasPrefix(assetPath, "assets/") && hashedAppAssetName.MatchString(path.Base(assetPath)) {
		return immutableCache
	}
	return appShellCache
}

// Vite and Rollup use an eight-character [hash] suffix by default. Only these
// generated asset names can safely use the immutable policy; fixed-name files
// and unrecognized names must revalidate.
var hashedAppAssetName = regexp.MustCompile(`^.+-[A-Za-z0-9_-]{8}\.[^/]+$`)

func contentType(relative string) string {
	if relative == "LICENSE" || relative == "THIRD_PARTY_NOTICES.txt" {
		return "text/plain; charset=utf-8"
	}
	extension := strings.ToLower(path.Ext(relative))
	switch extension {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".md", ".markdown":
		return "text/markdown; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs", ".cjs":
		return "text/javascript; charset=utf-8"
	case ".json", ".map":
		return "application/json; charset=utf-8"
	case ".webmanifest":
		return "application/manifest+json; charset=utf-8"
	case ".svg":
		return "image/svg+xml; charset=utf-8"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".webp":
		return "image/webp"
	case ".avif":
		return "image/avif"
	case ".ico":
		return "image/vnd.microsoft.icon"
	case ".woff":
		return "font/woff"
	case ".woff2":
		return "font/woff2"
	case ".ttf":
		return "font/ttf"
	case ".otf":
		return "font/otf"
	case ".pdf":
		return "application/pdf"
	case ".wasm":
		return "application/wasm"
	}
	return "application/octet-stream"
}
