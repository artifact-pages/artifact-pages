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

	deploymentconfig "github.com/tasuku43/git-artifact-pages/internal/config"
	"github.com/tasuku43/git-artifact-pages/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/internal/preview"
	"github.com/tasuku43/git-artifact-pages/internal/publisher"
	"github.com/tasuku43/git-artifact-pages/internal/registry"
)

type previewDocumentURL struct {
	Path  string `json:"path"`
	Title string `json:"title"`
	URL   string `json:"url"`
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
	sourcePath := flags.String("source", "", "registered source directory relative to the current Git repository")
	headRef := flags.String("head", "HEAD", "source Git head whose committed files form the preview")
	defaultRef := flags.String("default-ref", "origin/HEAD", "current default-branch ref used for merge-base selection")
	pullRequest := flags.String("pull-request", "", "explicit pull request number or canonical GitHub URL; omitted means manual preview")
	baseURL := flags.String("base-url", "", "public application origin used to build preview URLs")
	configLocator := flags.String("config", "", "local path or github://OWNER/REPO/FILE?ref=REF deployment config locator")
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
	if *sourcePath == "" {
		return withExitCode(errors.New("--source is required and must match the registered source path"), 2)
	}
	if *format != "text" && *format != "json" {
		return withExitCode(errors.New("--format must be text or json"), 2)
	}
	publicOrigin, err := validatePreviewPublicOrigin(*baseURL)
	if err != nil {
		return withExitCode(err, 2)
	}
	resolved, err := (deploymentconfig.Resolver{}).Resolve(ctx, *configLocator)
	if err != nil {
		return withExitCode(err, 2)
	}
	backend, err := newDeploymentBackend(ctx, resolved.Config)
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
	printPreviewPublishOutput(stdout, output)
	reportDeploymentConfig(stdout, resolved)
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
		output.Documents = append(output.Documents, previewDocumentURL{Path: document.Path, Title: document.Title, URL: documentURL})
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

func printPreviewPublishOutput(writer io.Writer, output previewPublishOutput) {
	fmt.Fprintf(writer, "Preview %s for site %s at %s.\n", output.Outcome, output.Site, output.HeadSHA)
	fmt.Fprintf(writer, "Preview group: %s\n", output.GroupListURL)
	for _, document := range output.Documents {
		fmt.Fprintf(writer, "  %s: %s\n", document.Path, document.URL)
	}
	for _, object := range output.Objects {
		fmt.Fprintf(writer, "  %s %s\n", object.Action, object.Path)
	}
	for _, change := range output.CatalogChanges {
		fmt.Fprintf(writer, "  catalog %s %s (%s)\n", change.Action, change.GroupID, change.Reason)
	}
}

func writePreviewUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages preview publish [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Build and publish one registered site's pre-merge review projection.")
}

func writePreviewPublishUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages preview publish --site ID --source DIR --base-url ORIGIN [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Build only changed documents from a Git head and publish their immutable preview revision.")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Options:")
	fmt.Fprintln(writer, "  --site ID               required registered site identifier")
	fmt.Fprintln(writer, "  --source DIR            required registered source directory in the current checkout")
	fmt.Fprintln(writer, "  --head REF              preview source Git head (default HEAD)")
	fmt.Fprintln(writer, "  --default-ref REF       default-branch ref for merge-base selection (default origin/HEAD)")
	fmt.Fprintln(writer, "  --pull-request REF      explicit PR number or canonical GitHub URL; omitted means manual")
	fmt.Fprintln(writer, "  --include PATH          extra source-relative resource path or path.Match pattern (repeatable)")
	fmt.Fprintln(writer, "  --base-url ORIGIN       public application origin for returned review URLs")
	fmt.Fprintln(writer, "  --config LOCATOR        deployment config path or github:// locator")
	fmt.Fprintln(writer, "  --dry-run               show document/resource and catalog changes without provider writes")
	fmt.Fprintln(writer, "  --format text|json      output a human-readable result or typed JSON")
}

var _ flag.Value = (*stringSliceFlag)(nil)
