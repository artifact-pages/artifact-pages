package publisher

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
)

// BuildAndPublishPreview builds a preview from Git and publishes it only while
// the target site is registered. The registry is re-read after acquiring the
// same per-site lock used by unregister, so an unregister that wins the lock
// cannot be followed by a publisher recreating the site's preview objects.
func BuildAndPublishPreview(ctx context.Context, backend DeploymentBackend, options preview.BuildOptions) (preview.BuildResult, error) {
	result, _, err := BuildAndPlanPreview(ctx, backend, options, false)
	return result, err
}

// BuildAndPlanPreview builds from the caller-selected source and validates it
// against the deployed registry before any provider mutation. A real publish
// performs that validation after acquiring the shared site lock. Dry-run does
// not acquire a lock because lock acquisition is a provider write; its plan is
// an observation that can become stale.
func BuildAndPlanPreview(ctx context.Context, backend DeploymentBackend, options preview.BuildOptions, dryRun bool) (preview.BuildResult, preview.PublicationPlan, error) {
	if ctx == nil {
		return preview.BuildResult{}, preview.PublicationPlan{}, errors.New("preview publication context is required")
	}
	if backend == nil {
		return preview.BuildResult{}, preview.PublicationPlan{}, errors.New("deployment backend is required")
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		return preview.BuildResult{}, preview.PublicationPlan{}, errors.New("deployment backend does not support origin reads and conditional writes")
	}
	if err := ctx.Err(); err != nil {
		return preview.BuildResult{}, preview.PublicationPlan{}, err
	}
	if strings.TrimSpace(options.SourcePath) == "" {
		// An omitted source defaults to the site's registered source path. The
		// registry is read again, and the path validated exactly, before any write.
		projection, err := loadOriginRegistry(ctx, conditional)
		if err != nil {
			return preview.BuildResult{}, preview.PublicationPlan{}, err
		}
		entry, ok := registrySite(projection, options.SiteID)
		if !ok {
			return preview.BuildResult{}, preview.PublicationPlan{}, siteNotRegistered(projection, options.SiteID)
		}
		options.SourcePath = entry.SourcePath
	}
	result, err := preview.BuildFromGit(ctx, options)
	if err != nil {
		return preview.BuildResult{}, preview.PublicationPlan{}, err
	}
	store, err := NewObjectPreviewStore(conditional)
	if err != nil {
		return result, preview.PublicationPlan{}, err
	}
	if dryRun {
		if err := validatePreviewRegistration(ctx, conditional, options); err != nil {
			return result, preview.PublicationPlan{}, err
		}
		plan, err := preview.PlanPublication(ctx, store, result)
		return result, plan, err
	}
	var plan preview.PublicationPlan
	err = store.WithSiteLock(ctx, result.Site, func(lockedContext context.Context) error {
		if err := validatePreviewRegistration(lockedContext, conditional, options); err != nil {
			return err
		}
		var publishErr error
		plan, publishErr = preview.PublishWithPlan(lockedContext, lockedPreviewStore{
			PreviewStore: store,
			site:         result.Site,
			ctx:          lockedContext,
		}, result)
		return publishErr
	})
	if err != nil {
		return result, plan, err
	}
	return result, plan, nil
}

func validatePreviewRegistration(ctx context.Context, backend ConditionalObjectBackend, options preview.BuildOptions) error {
	projection, err := loadOriginRegistry(ctx, backend)
	if err != nil {
		return err
	}
	entry, ok := registrySite(projection, options.SiteID)
	if !ok {
		return siteNotRegistered(projection, options.SiteID)
	}
	repository, _, currentRoot, err := indexer.ResolveGitRepositoryIdentity(ctx)
	if err != nil {
		return err
	}
	selectedRoot, err := gitRepositoryRoot(ctx, options.RepositoryDir)
	if err != nil {
		return fmt.Errorf("resolve selected preview checkout: %w", err)
	}
	if selectedRoot != currentRoot {
		return fmt.Errorf("preview checkout %q does not match the current registered Git checkout %q", selectedRoot, currentRoot)
	}
	if !strings.EqualFold(repository, entry.Repository) || options.SourcePath != entry.SourcePath {
		return fmt.Errorf("site %q is registered to %s:%s; selected preview checkout is %s:%s", options.SiteID, entry.Repository, entry.SourcePath, repository, options.SourcePath)
	}
	if options.Repository != "" && !strings.EqualFold(options.Repository, entry.Repository) {
		return fmt.Errorf("preview repository %q does not match registered repository %q for site %q", options.Repository, entry.Repository, options.SiteID)
	}
	return nil
}

func gitRepositoryRoot(ctx context.Context, repositoryDir string) (string, error) {
	if repositoryDir == "" {
		repositoryDir = "."
	}
	command := exec.CommandContext(ctx, "git", "-C", repositoryDir, "rev-parse", "--show-toplevel")
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("read Git working-tree root: %w: %s", err, strings.TrimSpace(string(output)))
	}
	root := strings.TrimSpace(string(output))
	root, err = filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("resolve Git working-tree root: %w", err)
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("resolve Git working-tree root: %w", err)
	}
	return root, nil
}

// lockedPreviewStore lets preview.Publish reuse the lock acquired above. The
// underlying ObjectPreviewStore still receives the lock-bearing context, so it
// can verify lock ownership before replacing the mutable catalog.
type lockedPreviewStore struct {
	preview.PreviewStore
	site string
	ctx  context.Context
}

func (store lockedPreviewStore) WithSiteLock(_ context.Context, site string, operation func(context.Context) error) error {
	if site != store.site {
		return fmt.Errorf("preview publication for site %q cannot use held %q site lock", site, store.site)
	}
	if operation == nil {
		return errors.New("preview lock operation is required")
	}
	if err := store.ctx.Err(); err != nil {
		return err
	}
	return operation(store.ctx)
}
