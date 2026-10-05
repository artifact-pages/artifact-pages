package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

type previewDocumentURL struct {
	Path             string   `json:"path"`
	Title            string   `json:"title"`
	URL              string   `json:"url"`
	Reason           string   `json:"reason"`
	ChangedResources []string `json:"changedResources,omitempty"`
}

type previewPublishOutput struct {
	Operation       string                             `json:"operation"`
	Outcome         string                             `json:"outcome"`
	Site            string                             `json:"site"`
	GroupID         string                             `json:"groupId,omitempty"`
	HeadSHA         string                             `json:"headSha,omitempty"`
	PullRequestURL  string                             `json:"pullRequestUrl,omitempty"`
	GroupListURL    string                             `json:"groupListUrl,omitempty"`
	Documents       []previewDocumentURL               `json:"documents"`
	Objects         []preview.PublicationObjectChange  `json:"objects"`
	CatalogChanges  []preview.PublicationCatalogChange `json:"catalogChanges"`
	ConfigCommitSHA string                             `json:"configCommitSha,omitempty"`
	Target          *deploymentTarget                  `json:"target,omitempty"`
	Error           string                             `json:"error,omitempty"`
}

type stringSliceFlag []string

func (value *stringSliceFlag) String() string { return strings.Join(*value, ",") }
func (value *stringSliceFlag) Set(input string) error {
	*value = append(*value, input)
	return nil
}

func runPreviewPublish(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("artifact-pages preview publish", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writePreviewPublishUsage(stderr) }
	siteID := flags.String("site", "", "registered site identifier")
	sourcePath := flags.String("source", "", "source directory relative to the current Git repository; defaults to the site's registered source path")
	headRef := flags.String("head", "HEAD", "source Git head whose committed files form the preview")
	defaultRef := flags.String("default-ref", "origin/HEAD", "current default-branch ref used for merge-base selection")
	pullRequest := flags.String("pull-request", "", "explicit pull request number or canonical GitHub URL; omitted means manual preview")
	baseURL := flags.String("base-url", "", "public application origin used to build preview URLs; defaults to publicBaseURL from the deployment config")
	var configLocators stringSliceFlag
	flags.Var(&configLocators, "config", "deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	dryRun := flags.Bool("dry-run", false, "show source, object, and catalog changes without writes, deletes, lock recovery, or cache changes")
	format := flags.String("format", "text", "result format: text or json")
	var includes stringSliceFlag
	flags.Var(&includes, "include", "additional source-relative resource path or path.Match pattern (repeatable)")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return withExitCode(err, 2)
	}
	if flags.NArg() != 0 {
		return withExitCode(fmt.Errorf("unexpected arguments: %v", flags.Args()), 2)
	}
	if *siteID == "" {
		return withExitCode(errors.New("--site is required"), 2)
	}
	if err := registry.ValidateSiteID(*siteID); err != nil {
		return withExitCode(err, 2)
	}
	if *format != "text" && *format != "json" {
		return withExitCode(errors.New("--format must be text or json"), 2)
	}
	if *baseURL != "" {
		if _, err := validatePreviewPublicOrigin(*baseURL); err != nil {
			return withExitCode(err, 2)
		}
	}
	resolved, err := (deploymentconfig.Resolver{}).ResolveLayers(ctx, configLocators)
	if err != nil {
		return withExitCode(err, 2)
	}
	// An explicit --base-url wins; otherwise the deployment config supplies it.
	originSource := *baseURL
	if originSource == "" {
		originSource = resolved.Config.EffectivePublicBaseURL()
		if originSource == "" {
			return withExitCode(errors.New("--base-url is required to produce review URLs: pass it or set publicBaseURL in the deployment config"), 2)
		}
	}
	publicOrigin, err := validatePreviewPublicOrigin(originSource)
	if err != nil {
		return withExitCode(err, 2)
	}
	backend, err := newDeploymentBackendWithCapabilities(ctx, resolved.Config, deploymentBackendCapabilities{useRegistryReader: true})
	if err != nil {
		return withResolvedError(err, resolved)
	}
	repository, _, _, err := indexer.ResolveGitRepositoryIdentity(ctx)
	if err != nil {
		return withResolvedError(err, resolved)
	}
	buildOptions := preview.BuildOptions{
		RepositoryDir: ".", SiteID: *siteID, SourcePath: *sourcePath,
		DefaultRef: *defaultRef, HeadRef: *headRef, Repository: repository,
		ExplicitResources: append([]string(nil), includes...),
	}
	if *pullRequest != "" {
		if _, err := preview.ParsePullRequestReference(repository, *pullRequest); err != nil {
			return withExitCode(err, 2)
		}
		pullRequestInfo, err := (preview.PullRequestResolver{Token: githubTokenFromEnv()}).Resolve(ctx, repository, *pullRequest)
		if err != nil {
			return withResolvedError(err, resolved)
		}
		buildOptions.PullRequestURL = pullRequestInfo.URL
		buildOptions.PullRequestHeadRepository = pullRequestInfo.HeadRepo
		buildOptions.PullRequestHeadSHA = pullRequestInfo.HeadSHA
	}
	buildResult, plan, err := publisher.BuildAndPlanPreview(ctx, backend, buildOptions, *dryRun)
	if err != nil {
		failure, outputErr := makePreviewPublishOutput(publicOrigin, buildResult, plan, *dryRun, resolved)
		if outputErr != nil {
			return withResolvedError(err, resolved)
		}
		failure.Outcome = "failed"
		failure.Error = err.Error()
		return withResolvedPreviewError(err, resolved, failure)
	}
	output, err := makePreviewPublishOutput(publicOrigin, buildResult, plan, *dryRun, resolved)
	if err != nil {
		return withExitCode(err, 2)
	}
	if *format == "json" {
		return json.NewEncoder(stdout).Encode(output)
	}
	printPreviewPublishReport(stdout, output, resolved, *dryRun)
	return nil
}

func githubTokenFromEnv() string {
	if token := os.Getenv("GITHUB_TOKEN"); token != "" {
		return token
	}
	return os.Getenv("GH_TOKEN")
}

func validatePreviewPublicOrigin(value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", errors.New("--base-url is required to produce review URLs")
	}
	if strings.TrimSpace(value) != value {
		return "", errors.New("--base-url must not contain surrounding whitespace")
	}
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", errors.New("--base-url must be an HTTP(S) origin without a path, query, or fragment")
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func makePreviewPublishOutput(publicOrigin string, result preview.BuildResult, plan preview.PublicationPlan, dryRun bool, resolved deploymentconfig.ResolvedConfig) (previewPublishOutput, error) {
	groupListURL, err := previewGroupURL(publicOrigin, result.Site, result.Group.ID)
	if err != nil {
		return previewPublishOutput{}, err
	}
	target := deploymentTargetFromConfig(resolved.Config)
	output := previewPublishOutput{
		Operation: "preview publish", Site: result.Site, GroupID: result.Group.ID,
		HeadSHA: result.Group.HeadSHA, PullRequestURL: result.Group.PRURL,
		GroupListURL: groupListURL, Documents: []previewDocumentURL{},
		Objects:         append([]preview.PublicationObjectChange(nil), plan.Objects...),
		CatalogChanges:  append([]preview.PublicationCatalogChange(nil), plan.CatalogChanges...),
		ConfigCommitSHA: resolved.CommitSHA, Target: &target,
	}
	if output.Objects == nil {
		output.Objects = []preview.PublicationObjectChange{}
	}
	if output.CatalogChanges == nil {
		output.CatalogChanges = []preview.PublicationCatalogChange{}
	}
	for _, document := range result.Group.Documents {
		documentURL, err := previewDocumentRoute(publicOrigin, result.Site, result.Group.HeadSHA, document.Path, result.Group.ID, result.Group.Kind == "pull-request")
		if err != nil {
			return previewPublishOutput{}, err
		}
		reason := document.Reason
		if reason == "" {
			reason = preview.ReasonChanged
		}
		output.Documents = append(output.Documents, previewDocumentURL{Path: document.Path, Title: document.Title, URL: documentURL, Reason: reason, ChangedResources: document.ChangedResources})
	}
	if result.Outcome == preview.OutcomeNoPreview {
		output.Outcome = string(preview.OutcomeNoPreview)
	} else if dryRun {
		if len(plan.CatalogChanges) == 0 && allRetained(plan.Objects) {
			output.Outcome = "no-op"
		} else {
			output.Outcome = "planned"
		}
	} else if len(plan.CatalogChanges) == 0 && allRetained(plan.Objects) {
		output.Outcome = "no-op"
	} else {
		output.Outcome = string(preview.OutcomePublished)
	}
	return output, nil
}

func allRetained(objects []preview.PublicationObjectChange) bool {
	for _, object := range objects {
		if object.Action != "retain" {
			return false
		}
	}
	return true
}

func previewGroupURL(publicOrigin, site, groupID string) (string, error) {
	if err := registry.ValidateSiteID(site); err != nil {
		return "", err
	}
	values := url.Values{}
	values.Set("group", groupID)
	return publicOrigin + "/" + site + "/_previews?" + values.Encode(), nil
}

func previewDocumentRoute(publicOrigin, site, headSHA, documentPath, groupID string, includeGroup bool) (string, error) {
	readerGroup := ""
	if includeGroup {
		readerGroup = groupID
	}
	route, err := preview.DocumentRouteHref(site, headSHA, documentPath, readerGroup)
	if err != nil {
		return "", err
	}
	return publicOrigin + route, nil
}

func printPreviewPublishReport(writer io.Writer, output previewPublishOutput, resolved deploymentconfig.ResolvedConfig, dry bool) {
	reportHeader(writer, "preview publish "+output.Site, output.Outcome, dry)
	if resolved.Config.Provider != "" {
		reportTarget(writer, resolved)
	}
	fmt.Fprintf(writer, "  Head      %s\n", reportText(output.HeadSHA))
	if output.PullRequestURL != "" {
		fmt.Fprintf(writer, "  PR        %s\n", reportText(output.PullRequestURL))
	}
	if output.GroupListURL != "" {
		fmt.Fprintf(writer, "  Preview group: %s\n", reportText(output.GroupListURL))
	}
	if len(output.Documents) > 0 {
		fmt.Fprintf(writer, "\n  Documents · %d\n", len(output.Documents))
		for i, document := range output.Documents {
			if i == publishReportPathLimit {
				fmt.Fprintf(writer, "    … %d more; use --format json for all URLs.\n", len(output.Documents)-i)
				break
			}
			label := ""
			if document.Reason == preview.ReasonDependency {
				label = " (affected by resource change)"
			}
			fmt.Fprintf(writer, "    %s%s\n    %s\n", reportText(document.Path), label, reportText(document.URL))
		}
	}
	objects := make([]publisher.Change, 0, len(output.Objects))
	for _, object := range output.Objects {
		objects = append(objects, publisher.Change{Action: object.Action, Path: object.Path})
	}
	reportChanges(writer, "Preview objects", objects)
	catalog := make([]publisher.Change, 0, len(output.CatalogChanges))
	for _, change := range output.CatalogChanges {
		catalog = append(catalog, publisher.Change{Action: change.Action, Path: change.GroupID + " (" + change.Reason + ")"})
	}
	reportChanges(writer, "Preview catalog", catalog)
	footer := "Preview publish complete."
	if dry {
		footer = "Dry run complete. No writes."
	} else if output.Outcome == "no-op" {
		footer = "Everything is up to date."
	} else if output.Outcome == "no-preview" {
		footer = "No added or changed documents to preview. No preview was published."
	}
	fmt.Fprintf(writer, "\n  %s\n", footer)
}

func writePreviewUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages preview publish [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Build and publish one registered site's pre-merge review projection.")
}

func writePreviewPublishUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages preview publish --site ID [--source DIR] [--base-url ORIGIN] [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Build only changed documents from a Git head and publish their immutable preview revision.")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Options:")
	fmt.Fprintln(writer, "  --site ID               required registered site identifier")
	fmt.Fprintln(writer, "  --source DIR            source directory in the current checkout (default: the site's registered source path; an explicit value must match it)")
	fmt.Fprintln(writer, "  --head REF              preview source Git head (default HEAD)")
	fmt.Fprintln(writer, "  --default-ref REF       default-branch ref for merge-base selection (default origin/HEAD)")
	fmt.Fprintln(writer, "  --pull-request REF      explicit PR number or canonical GitHub URL; omitted means manual")
	fmt.Fprintln(writer, "  --include PATH          extra source-relative resource path or path.Match pattern (repeatable)")
	fmt.Fprintln(writer, "  --base-url ORIGIN       public application origin for returned review URLs (default: publicBaseURL from the deployment config)")
	fmt.Fprintln(writer, "  --config LOCATOR        deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	fmt.Fprintln(writer, "  --dry-run               show document/resource and catalog changes without provider writes")
	fmt.Fprintln(writer, "  --format text|json      output a human-readable result or typed JSON")
}

var _ flag.Value = (*stringSliceFlag)(nil)
