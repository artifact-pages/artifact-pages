package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	deploymentconfig "github.com/tasuku43/git-artifact-pages/cli/internal/config"
	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
	"github.com/tasuku43/git-artifact-pages/cli/internal/publisher"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
)

func main() {
	args := os.Args[1:]
	if err := run(context.Background(), args, os.Stdout, os.Stderr); err != nil {
		var commandErr *commandError
		failure := failureResult(args, err)
		if errors.As(err, &commandErr) {
			failure.ConfigCommitSHA = commandErr.configCommitSHA
			failure.Target = commandErr.target
			if commandErr.result != nil {
				failure.Result = *commandErr.result
				failure.Result.Outcome = "failed"
				if failure.Result.Operation == "" {
					failure.Result.Operation = failureEnvelopeOperation(args)
				}
				if failure.Result.Site == "" {
					failure.Result.Site = failureSite(args)
				}
				if failure.Result.Changes == nil {
					failure.Result.Changes = []publisher.Change{}
				}
			}
		}
		if failure.Result.Operation == "site publish" && failure.Result.PreviewChanges == nil {
			failure.Result.PreviewChanges = emptyPreviewChanges()
		}
		if requestedFormat(args) == "json" {
			if failure.Result.Operation == "preview publish" {
				_ = json.NewEncoder(os.Stdout).Encode(previewFailureResult(args, err, commandErr))
			} else {
				_ = json.NewEncoder(os.Stdout).Encode(failure)
			}
		}
		if commandErr != nil && commandErr.configCommitSHA != "" && requestedFormat(args) != "json" {
			fmt.Fprintf(os.Stderr, "Deployment config commit: %s\n", commandErr.configCommitSHA)
		}
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(commandExitCode(err))
	}
}

type commandError struct {
	err             error
	exitCode        int
	result          *publisher.Result
	target          *deploymentTarget
	previewResult   *previewPublishOutput
	configCommitSHA string
}

func (failure *commandError) Error() string { return failure.err.Error() }
func (failure *commandError) Unwrap() error { return failure.err }

type failureEnvelope struct {
	publisher.Result
	ConfigCommitSHA string            `json:"configCommitSha,omitempty"`
	Target          *deploymentTarget `json:"target,omitempty"`
	Error           string            `json:"error"`
}

type deploymentResultEnvelope struct {
	publisher.Result
	ConfigCommitSHA string           `json:"configCommitSha,omitempty"`
	Target          deploymentTarget `json:"target"`
}

type deploymentTarget struct {
	Provider  string `json:"provider"`
	Bucket    string `json:"bucket,omitempty"`
	Region    string `json:"region,omitempty"`
	AccountID string `json:"accountId,omitempty"`
}

func withExitCode(err error, code int) error {
	if err == nil {
		return nil
	}
	return &commandError{err: err, exitCode: code}
}

func withResolvedError(err error, resolved deploymentconfig.ResolvedConfig) error {
	if err == nil {
		return nil
	}
	target := deploymentTargetFromConfig(resolved.Config)
	return &commandError{err: err, exitCode: 1, configCommitSHA: resolved.CommitSHA, target: &target}
}

func withResolvedResult(err error, result publisher.Result, resolved deploymentconfig.ResolvedConfig) error {
	if err == nil {
		return nil
	}
	target := deploymentTargetFromConfig(resolved.Config)
	return &commandError{err: err, exitCode: 1, result: &result, configCommitSHA: resolved.CommitSHA, target: &target}
}

func withResolvedPreviewError(err error, resolved deploymentconfig.ResolvedConfig, result previewPublishOutput) error {
	if err == nil {
		return nil
	}
	target := deploymentTargetFromConfig(resolved.Config)
	return &commandError{err: err, exitCode: 1, previewResult: &result, configCommitSHA: resolved.CommitSHA, target: &target}
}

func previewFailureResult(args []string, err error, commandErr *commandError) previewPublishOutput {
	result := previewPublishOutput{
		Operation: "preview publish", Outcome: "failed", Site: failureSite(args),
		Objects: []preview.PublicationObjectChange{}, CatalogChanges: []preview.PublicationCatalogChange{},
		Documents: []previewDocumentURL{},
	}
	if commandErr != nil {
		if commandErr.previewResult != nil {
			result = *commandErr.previewResult
		}
		result.ConfigCommitSHA = commandErr.configCommitSHA
		if commandErr.target != nil {
			result.Target = commandErr.target
		}
	}
	result.Operation = "preview publish"
	result.Outcome = "failed"
	if result.Site == "" {
		result.Site = failureSite(args)
	}
	result.Error = err.Error()
	if result.Objects == nil {
		result.Objects = []preview.PublicationObjectChange{}
	}
	if result.CatalogChanges == nil {
		result.CatalogChanges = []preview.PublicationCatalogChange{}
	}
	if result.Documents == nil {
		result.Documents = []previewDocumentURL{}
	}
	return result
}

func encodeDeploymentResult(writer io.Writer, result publisher.Result, resolved deploymentconfig.ResolvedConfig) error {
	return json.NewEncoder(writer).Encode(deploymentResultEnvelope{
		Result: result, ConfigCommitSHA: resolved.CommitSHA, Target: deploymentTargetFromConfig(resolved.Config),
	})
}

func deploymentTargetFromConfig(config deploymentconfig.DeploymentConfig) deploymentTarget {
	target := deploymentTarget{Provider: config.Provider}
	switch config.Provider {
	case "aws":
		if config.AWS != nil {
			target.Bucket, target.Region, target.AccountID = config.AWS.Bucket, config.AWS.Region, config.AWS.AccountID
		}
	case "cloudflare":
		if config.Cloudflare != nil {
			target.Bucket, target.AccountID = config.Cloudflare.Bucket, config.Cloudflare.AccountID
		}
	case "gcp-local":
		if config.GCSLocal != nil {
			target.Bucket = config.GCSLocal.Bucket
		}
	}
	return target
}

func formatDeploymentTarget(config deploymentconfig.DeploymentConfig) string {
	target := deploymentTargetFromConfig(config)
	switch target.Provider {
	case "local":
		return "local filesystem storage"
	case "aws":
		if target.AccountID != "" {
			return fmt.Sprintf("AWS S3 bucket %s (region %s, account %s)", target.Bucket, target.Region, target.AccountID)
		}
		return fmt.Sprintf("AWS S3 bucket %s (region %s)", target.Bucket, target.Region)
	case "cloudflare":
		return fmt.Sprintf("Cloudflare R2 bucket %s (account %s)", target.Bucket, target.AccountID)
	case "gcp-local":
		return fmt.Sprintf("local GCS bucket %s", target.Bucket)
	default:
		return target.Provider
	}
}

func reportDeploymentConfig(writer io.Writer, resolved deploymentconfig.ResolvedConfig) {
	fmt.Fprintf(writer, "Deployment target: %s\n", formatDeploymentTarget(resolved.Config))
	if resolved.CommitSHA != "" {
		fmt.Fprintf(writer, "Deployment config commit: %s\n", resolved.CommitSHA)
	}
}

func commandExitCode(err error) int {
	var commandErr *commandError
	if errors.As(err, &commandErr) && commandErr.exitCode != 0 {
		return commandErr.exitCode
	}
	return 1
}

func requestedFormat(args []string) string {
	for index, arg := range args {
		if strings.HasPrefix(arg, "--format=") {
			return strings.TrimPrefix(arg, "--format=")
		}
		if arg == "--format" && index+1 < len(args) {
			return args[index+1]
		}
	}
	return "text"
}

func failureResult(args []string, err error) failureEnvelope {
	result := publisher.Result{Operation: failureEnvelopeOperation(args), Outcome: "failed", Site: failureSite(args), Changes: []publisher.Change{}}
	if result.Operation == "site publish" {
		result.PreviewChanges = emptyPreviewChanges()
	}
	return failureEnvelope{
		Result: result,
		Error:  err.Error(),
	}
}

func emptyPreviewChanges() *[]preview.CatalogReconciliationChange {
	changes := []preview.CatalogReconciliationChange{}
	return &changes
}

func failureEnvelopeOperation(args []string) string {
	operation := "artifact-pages"
	if len(args) > 0 {
		operation = args[0]
	}
	if len(args) > 1 {
		operation += " " + args[1]
	}
	return operation
}

func failureSite(args []string) string {
	siteID := ""
	for index, arg := range args {
		if strings.HasPrefix(arg, "--site=") {
			siteID = strings.TrimPrefix(arg, "--site=")
		} else if arg == "--site" && index+1 < len(args) {
			siteID = args[index+1]
		}
	}
	return siteID
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		writeRootUsage(stdout)
		return nil
	}
	if args[0] == "app" {
		if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
			writeAppUsage(stdout)
			return nil
		}
		if args[1] != "deploy" {
			writeAppUsage(stderr)
			return withExitCode(fmt.Errorf("unknown app command %q", args[1]), 2)
		}
		if len(args) < 3 || args[2] == "--help" || args[2] == "-h" {
			writeAppDeployUsage(stdout)
			return nil
		}
		return runAppDeploy(ctx, args[2:], stdout, stderr)
	}
	if args[0] == "preview" {
		if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
			writePreviewUsage(stdout)
			return nil
		}
		if args[1] != "publish" {
			writePreviewUsage(stderr)
			return withExitCode(fmt.Errorf("unknown preview command %q", args[1]), 2)
		}
		if len(args) < 3 || args[2] == "--help" || args[2] == "-h" {
			writePreviewPublishUsage(stdout)
			return nil
		}
		return runPreviewPublish(ctx, args[2:], stdout, stderr)
	}
	if args[0] == "site" {
		if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
			writeSiteUsage(stdout)
			return nil
		}
		if args[1] != "publish" {
			writeSiteUsage(stderr)
			return withExitCode(fmt.Errorf("unknown site command %q", args[1]), 2)
		}
		if len(args) < 3 || args[2] == "--help" || args[2] == "-h" {
			writeSitePublishUsage(stdout)
			return nil
		}
		return runSitePublish(ctx, args[2:], stdout, stderr)
	}
	if args[0] == "config" {
		if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
			writeConfigUsage(stdout)
			return nil
		}
		if args[1] != "set-default" || len(args) != 3 {
			writeConfigUsage(stderr)
			return withExitCode(errors.New("usage: artifact-pages config set-default LOCATOR"), 2)
		}
		path, err := (deploymentconfig.Resolver{}).SetDefault(args[2])
		if err != nil {
			return withExitCode(err, 2)
		}
		fmt.Fprintf(stdout, "Saved default deployment config locator in %s.\n", path)
		return nil
	}
	if args[0] == "lock" {
		if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
			writeLockUsage(stdout)
			return nil
		}
		if args[1] != "inspect" && args[1] != "recover" {
			writeLockUsage(stderr)
			return withExitCode(fmt.Errorf("unknown lock command %q", args[1]), 2)
		}
		return runLockCommand(ctx, args[1], args[2:], stdout, stderr)
	}
	if args[0] == "registry" {
		if len(args) < 2 || args[1] == "--help" || args[1] == "-h" {
			writeRegistryUsage(stdout)
			return nil
		}
		if args[1] == "register" {
			if len(args) < 3 || args[2] == "--help" || args[2] == "-h" {
				writeRegistryRegisterUsage(stdout)
				return nil
			}
			return runRegistryRegister(ctx, args[2:], stdout, stderr)
		}
		if args[1] == "unregister" {
			if len(args) < 3 || args[2] == "--help" || args[2] == "-h" {
				writeRegistryUnregisterUsage(stdout)
				return nil
			}
			return runRegistryUnregister(ctx, args[2:], stdout, stderr)
		}
		writeRegistryUsage(stderr)
		return withExitCode(fmt.Errorf("unknown registry command %q", args[1]), 2)
	}
	if args[0] != "index" {
		writeRootUsage(stderr)
		return withExitCode(fmt.Errorf("unknown command %q", args[0]), 2)
	}
	if len(args) == 1 || args[1] == "--help" || args[1] == "-h" {
		writeIndexUsage(stdout)
		return nil
	}
	if args[1] != "build" {
		writeIndexUsage(stderr)
		return withExitCode(fmt.Errorf("unknown index command %q", args[1]), 2)
	}

	flags := flag.NewFlagSet("artifact-pages index build", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writeBuildUsage(stderr) }
	siteID := flags.String("site", "", "site identifier (for example: sre)")
	siteTitle := flags.String("site-title", "", "display title for the site (defaults to the site identifier)")
	sourceDir := flags.String("source", "", "publishable static content directory inside the current Git working tree")
	outputDir := flags.String("out", ".local/storage", "projection output directory for site metadata and artifact index")
	repository := flags.String("repository", "", "source repository name, such as owner/repository (inferred from origin when possible)")
	repositoryURL := flags.String("repository-url", "", "canonical source repository URL (inferred from origin when possible)")
	ref := flags.String("ref", "", "source Git ref (inferred from the current branch or commit)")
	if err := flags.Parse(args[2:]); err != nil {
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
	if *sourceDir == "" {
		return withExitCode(errors.New("--source is required"), 2)
	}

	result, err := indexer.Build(ctx, indexer.BuildOptions{
		SiteID:        *siteID,
		SiteTitle:     *siteTitle,
		SourceDir:     *sourceDir,
		OutputDir:     *outputDir,
		Repository:    *repository,
		RepositoryURL: *repositoryURL,
		Ref:           *ref,
	})
	if err != nil {
		return err
	}

	outputPath := result.OutputPath
	if workingDir, err := os.Getwd(); err == nil {
		if relative, relErr := filepath.Rel(workingDir, outputPath); relErr == nil {
			outputPath = relative
		}
	}
	fmt.Fprintf(stdout, "Indexed %d artifacts from %d files in %s.\n", result.ArtifactsIndexed, result.FilesScanned, result.Elapsed.Round(time.Millisecond))
	fmt.Fprintf(stdout, "Wrote %s (%d bytes).\n", outputPath, result.OutputBytes)
	metadataPath := result.MetadataPath
	if workingDir, err := os.Getwd(); err == nil {
		if relative, relErr := filepath.Rel(workingDir, metadataPath); relErr == nil {
			metadataPath = relative
		}
	}
	fmt.Fprintf(stdout, "Wrote %s (%d bytes).\n", metadataPath, result.MetadataBytes)
	return nil
}

func runRegistryRegister(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("artifact-pages registry register", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writeRegistryRegisterUsage(stderr) }
	var configLocators stringSliceFlag
	flags.Var(&configLocators, "config", "deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	dryRun := flags.Bool("dry-run", false, "show planned changes without writes, deletes, lock recovery, or cache changes")
	format := flags.String("format", "text", "result format: text or json")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return withExitCode(err, 2)
	}
	if flags.NArg() != 0 {
		return withExitCode(fmt.Errorf("unexpected arguments: %v", flags.Args()), 2)
	}
	if *format != "text" && *format != "json" {
		return withExitCode(errors.New("--format must be text or json"), 2)
	}
	resolved, err := (deploymentconfig.Resolver{}).ResolveLayers(ctx, configLocators)
	if err != nil {
		return withExitCode(err, 2)
	}
	if resolved.Config.Sites == nil {
		return withExitCode(errors.New("deployment config must include a sites mapping for registry operations (use sites: {} for an empty registry)"), 2)
	}
	desired, err := registry.ProjectSites(resolved.Config.Sites)
	if err != nil {
		return withExitCode(err, 2)
	}
	backend, err := newDeploymentBackend(ctx, resolved.Config)
	if err != nil {
		return withResolvedError(err, resolved)
	}
	result, err := publisher.RegisterSites(ctx, backend, desired, *dryRun)
	if err != nil {
		return withResolvedResult(err, result, resolved)
	}
	if *format == "json" {
		return encodeDeploymentResult(stdout, result, resolved)
	}
	switch result.Outcome {
	case "planned":
		fmt.Fprintf(stdout, "Registry plan via %s: %d changes.\n", resolved.Config.Provider, len(result.Changes))
	case "no-op":
		fmt.Fprintf(stdout, "Registry is already up to date via %s.\n", resolved.Config.Provider)
	default:
		fmt.Fprintf(stdout, "Registered sites via %s.\n", resolved.Config.Provider)
	}
	reportDeploymentConfig(stdout, resolved)
	return nil
}

func runRegistryUnregister(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("artifact-pages registry unregister", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writeRegistryUnregisterUsage(stderr) }
	siteID := flags.String("site", "", "site identifier to unregister")
	var configLocators stringSliceFlag
	flags.Var(&configLocators, "config", "deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	dryRun := flags.Bool("dry-run", false, "show planned changes without writes, deletes, lock recovery, or cache changes")
	format := flags.String("format", "text", "result format: text or json")
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
	resolved, err := (deploymentconfig.Resolver{}).ResolveLayers(ctx, configLocators)
	if err != nil {
		return withExitCode(err, 2)
	}
	if resolved.Config.Sites == nil {
		return withExitCode(errors.New("deployment config must include a sites mapping for registry operations (use sites: {} for an empty registry)"), 2)
	}
	desired, err := registry.ProjectSites(resolved.Config.Sites)
	if err != nil {
		return withExitCode(err, 2)
	}
	for _, entry := range desired.Sites {
		if entry.ID == *siteID {
			return withExitCode(fmt.Errorf("site %q is still present in config sites; remove it before unregistering", *siteID), 2)
		}
	}
	backend, err := newDeploymentBackend(ctx, resolved.Config)
	if err != nil {
		return withResolvedError(err, resolved)
	}
	result, err := publisher.UnregisterSite(ctx, backend, desired, *siteID, *dryRun)
	if err != nil {
		return withResolvedResult(err, result, resolved)
	}
	if *format == "json" {
		return encodeDeploymentResult(stdout, result, resolved)
	}
	if result.Outcome == "planned" {
		fmt.Fprintf(stdout, "Unregister plan for %s via %s: %d changes.\n", *siteID, resolved.Config.Provider, len(result.Changes))
	} else if result.Outcome == "no-op" {
		fmt.Fprintf(stdout, "Site %s is already unregistered via %s.\n", *siteID, resolved.Config.Provider)
	} else {
		fmt.Fprintf(stdout, "Unregistered site %s via %s and removed %d objects.\n", *siteID, resolved.Config.Provider, result.FilesRemoved)
	}
	reportDeploymentConfig(stdout, resolved)
	return nil
}

func runLockCommand(ctx context.Context, command string, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("artifact-pages lock "+command, flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writeLockCommandUsage(stderr, command) }
	siteID := flags.String("site", "", "site identifier")
	scope := flags.String("scope", "site", "lock scope: site or registry")
	observedETag := flags.String("observed-etag", "", "ETag returned by lock inspect")
	var configLocators stringSliceFlag
	flags.Var(&configLocators, "config", "deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	format := flags.String("format", "text", "result format: text or json")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return withExitCode(err, 2)
	}
	if flags.NArg() != 0 {
		return withExitCode(fmt.Errorf("unexpected arguments: %v", flags.Args()), 2)
	}
	if *scope != "site" && *scope != "registry" {
		return withExitCode(errors.New("--scope must be site or registry"), 2)
	}
	if *scope == "site" && *siteID == "" {
		return withExitCode(errors.New("--site is required for site lock scope"), 2)
	}
	if *scope == "registry" && *siteID != "" {
		return withExitCode(errors.New("--site cannot be combined with --scope registry"), 2)
	}
	if command == "recover" && *observedETag == "" {
		return withExitCode(errors.New("--observed-etag is required"), 2)
	}
	if *format != "text" && *format != "json" {
		return withExitCode(errors.New("--format must be text or json"), 2)
	}
	resolved, err := (deploymentconfig.Resolver{}).ResolveLayers(ctx, configLocators)
	if err != nil {
		return withExitCode(err, 2)
	}
	backend, err := newDeploymentBackend(ctx, resolved.Config)
	if err != nil {
		return withResolvedError(err, resolved)
	}
	conditional, ok := backend.(publisher.ConditionalObjectBackend)
	if !ok {
		return withResolvedError(errors.New("deployment backend does not support lock operations"), resolved)
	}
	manager := publisher.SiteLockManager{Backend: conditional}
	lockName := *siteID
	if *scope == "registry" {
		lockName = "registry"
	}
	result := publisher.Result{Operation: "lock " + command, Site: lockName, Changes: []publisher.Change{}}
	if command == "inspect" {
		var snapshot publisher.LockSnapshot
		if *scope == "registry" {
			snapshot, err = manager.InspectRegistry(ctx)
		} else {
			snapshot, err = manager.Inspect(ctx, *siteID)
		}
		if err != nil {
			return withResolvedResult(err, result, resolved)
		}
		result.Outcome, result.Lock = "inspected", &snapshot
	} else {
		var recoverErr error
		if *scope == "registry" {
			recoverErr = manager.RecoverRegistry(ctx, *observedETag)
		} else {
			recoverErr = manager.Recover(ctx, *siteID, *observedETag)
		}
		if recoverErr != nil {
			return withResolvedResult(recoverErr, result, resolved)
		}
		var snapshot publisher.LockSnapshot
		if *scope == "registry" {
			snapshot, err = manager.InspectRegistry(ctx)
		} else {
			snapshot, err = manager.Inspect(ctx, *siteID)
		}
		if err != nil {
			return withResolvedResult(err, result, resolved)
		}
		result.Outcome, result.Lock = "recovered", &snapshot
	}
	if *format == "json" {
		return encodeDeploymentResult(stdout, result, resolved)
	}
	fmt.Fprintf(stdout, "Site %s lock: %s", result.Lock.Site, result.Lock.State)
	if result.Lock.ETag != "" {
		fmt.Fprintf(stdout, " (ETag %s)", result.Lock.ETag)
	}
	fmt.Fprintln(stdout, ".")
	reportDeploymentConfig(stdout, resolved)
	return nil
}

func runAppDeploy(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("artifact-pages app deploy", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writeAppDeployUsage(stderr) }
	archive := flags.String("archive", "", "local web release archive (.tar.gz) with adjacent manifest and checksum files")
	version := flags.String("version", "", "download this published web release version from GitHub")
	repository := flags.String("repository", "tasuku43/git-artifact-pages", "GitHub repository that publishes the web release")
	var configLocators stringSliceFlag
	flags.Var(&configLocators, "config", "deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	dryRun := flags.Bool("dry-run", false, "show planned changes without writes, deletes, lock recovery, or cache changes")
	format := flags.String("format", "text", "result format: text or json")
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return withExitCode(err, 2)
	}
	if flags.NArg() != 0 {
		return withExitCode(fmt.Errorf("unexpected arguments: %v", flags.Args()), 2)
	}
	if (*archive == "") == (*version == "") {
		return withExitCode(errors.New("choose exactly one of --archive or --version"), 2)
	}
	if *format != "text" && *format != "json" {
		return withExitCode(errors.New("--format must be text or json"), 2)
	}
	resolved, err := (deploymentconfig.Resolver{}).ResolveLayers(ctx, configLocators)
	if err != nil {
		return withExitCode(err, 2)
	}
	backend, err := newDeploymentBackend(ctx, resolved.Config)
	if err != nil {
		return withResolvedError(err, resolved)
	}
	result, err := publisher.DeployApp(ctx, backend, publisher.AppDeployOptions{
		ArchivePath: *archive,
		Version:     *version,
		Repository:  *repository,
		DryRun:      *dryRun,
	})
	if err != nil {
		return withResolvedResult(err, result, resolved)
	}
	if *format == "json" {
		return encodeDeploymentResult(stdout, result, resolved)
	}
	if result.Outcome == "planned" {
		fmt.Fprintf(stdout, "App deploy plan for %s via %s: %d files; no writes.\n", result.Version, resolved.Config.Provider, len(result.Changes))
		reportDeploymentConfig(stdout, resolved)
		return nil
	}
	if result.Outcome == "no-op" {
		fmt.Fprintf(stdout, "Artifact Pages web %s is already current via %s.\n", result.Version, resolved.Config.Provider)
		reportDeploymentConfig(stdout, resolved)
		return nil
	}
	fmt.Fprintf(stdout, "Deployed Artifact Pages web %s: %d files via %s.\n", result.Version, result.FilesPublished, resolved.Config.Provider)
	if result.InvalidationID != "" {
		fmt.Fprintf(stdout, "Cache revalidation request: %s\n", result.InvalidationID)
	}
	if result.SourceDirty {
		fmt.Fprintln(stderr, "Warning: this web bundle was built from a source working tree with uncommitted changes.")
	}
	reportDeploymentConfig(stdout, resolved)
	return nil
}

func runSitePublish(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("artifact-pages site publish", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { writeSitePublishUsage(stderr) }
	siteID := flags.String("site", "", "site identifier (for example: sre)")
	source := flags.String("source", "", "publishable static content directory inside the current Git working tree")
	var configLocators stringSliceFlag
	flags.Var(&configLocators, "config", "deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	dryRun := flags.Bool("dry-run", false, "show planned changes without writes, deletes, lock recovery, or cache changes")
	format := flags.String("format", "text", "result format: text or json")
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
	if *format != "text" && *format != "json" {
		return withExitCode(errors.New("--format must be text or json"), 2)
	}
	resolved, err := (deploymentconfig.Resolver{}).ResolveLayers(ctx, configLocators)
	if err != nil {
		return withExitCode(err, 2)
	}
	backend, err := newDeploymentBackendWithCapabilities(ctx, resolved.Config, deploymentBackendCapabilities{useRegistryReader: true})
	if err != nil {
		return withResolvedError(err, resolved)
	}
	result, err := publisher.PublishSite(ctx, backend, publisher.SitePublishOptions{
		SiteID:    *siteID,
		SourceDir: *source,
		DryRun:    *dryRun,
	})
	if err != nil {
		return withResolvedResult(err, result, resolved)
	}
	if *format == "json" {
		return encodeDeploymentResult(stdout, result, resolved)
	}
	switch result.Outcome {
	case "planned":
		fmt.Fprintf(stdout, "Plan for site %s via %s: %d creates, %d updates, %d removals.\n", *siteID, resolved.Config.Provider, changeCount(result.Changes, "create"), changeCount(result.Changes, "update"), changeCount(result.Changes, "remove"))
		fmt.Fprintf(stdout, "Preview catalog: %d stale references to prune, %d groups retained. No writes.\n", previewChangeCount(result.PreviewChanges, "remove"), previewChangeCount(result.PreviewChanges, "keep"))
	case "no-op":
		if *dryRun {
			fmt.Fprintf(stdout, "Plan for site %s via %s: %d creates, %d updates, %d removals.\n", *siteID, resolved.Config.Provider, changeCount(result.Changes, "create"), changeCount(result.Changes, "update"), changeCount(result.Changes, "remove"))
			fmt.Fprintf(stdout, "Preview catalog: %d stale references to prune, %d groups retained. No writes.\n", previewChangeCount(result.PreviewChanges, "remove"), previewChangeCount(result.PreviewChanges, "keep"))
		} else {
			fmt.Fprintf(stdout, "Site %s is already up to date via %s.\n", *siteID, resolved.Config.Provider)
			if retained := previewChangeCount(result.PreviewChanges, "keep"); retained > 0 {
				fmt.Fprintf(stdout, "Preview catalog: %d groups retained; no stale references found.\n", retained)
			}
		}
	default:
		fmt.Fprintf(stdout, "Published site %s: %d files uploaded, %d stale files removed via %s.\n", *siteID, result.FilesPublished, result.FilesRemoved, resolved.Config.Provider)
		if result.PreviewChanges != nil && len(*result.PreviewChanges) > 0 {
			pruned := previewChangeCount(result.PreviewChanges, "remove")
			fmt.Fprintf(stdout, "Reconciled preview catalog: %d stale references pruned; %d groups retained.\n", pruned, previewChangeCount(result.PreviewChanges, "keep"))
		}
	}
	reportDeploymentConfig(stdout, resolved)
	return nil
}

func previewChangeCount(changes *[]preview.CatalogReconciliationChange, action string) int {
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

func changeCount(changes []publisher.Change, action string) int {
	count := 0
	for _, change := range changes {
		if change.Action == action {
			count++
		}
	}
	return count
}

type deploymentBackendCapabilities struct {
	useRegistryReader bool
}

func newDeploymentBackend(ctx context.Context, config deploymentconfig.DeploymentConfig) (publisher.DeploymentBackend, error) {
	return newDeploymentBackendWithCapabilities(ctx, config, deploymentBackendCapabilities{})
}

func newDeploymentBackendWithCapabilities(ctx context.Context, config deploymentconfig.DeploymentConfig, capabilities deploymentBackendCapabilities) (publisher.DeploymentBackend, error) {
	var err error
	config, err = config.WithDefaults()
	if err != nil {
		return nil, err
	}
	if err := config.Validate(); err != nil {
		return nil, err
	}
	switch config.Provider {
	case "local":
		return publisher.NewDirectoryBackend(config.Local.Root)
	case "aws":
		return publisher.NewAWSBackend(ctx, publisher.AWSOptions{
			Region: config.AWS.Region, Bucket: config.AWS.Bucket, DistributionID: config.AWS.DistributionID,
		})
	case "cloudflare":
		credentials := config.Cloudflare
		var registryReaderAccessKeyID, registryReaderSecretAccessKey, registryReaderSessionToken string
		if capabilities.useRegistryReader && credentials.RegistryReaderAccessKeyIDEnv != "" {
			registryReaderAccessKeyID = os.Getenv(credentials.RegistryReaderAccessKeyIDEnv)
			registryReaderSecretAccessKey = os.Getenv(credentials.RegistryReaderSecretAccessKeyEnv)
			registryReaderSessionToken = os.Getenv(credentials.RegistryReaderSessionTokenEnv)
			if strings.TrimSpace(registryReaderAccessKeyID) == "" || strings.TrimSpace(registryReaderSecretAccessKey) == "" {
				return nil, errors.New("Cloudflare registry reader credentials named by deployment config are not set")
			}
		}
		return publisher.NewCloudflareBackend(ctx, publisher.CloudflareOptions{
			AccountID: credentials.AccountID, Bucket: credentials.Bucket, ZoneID: credentials.ZoneID,
			PublicBaseURL: credentials.PublicBaseURL, AccessKeyID: os.Getenv(credentials.AccessKeyIDEnv),
			SecretKey: os.Getenv(credentials.SecretAccessKeyEnv), SessionToken: os.Getenv(credentials.SessionTokenEnv),
			RegistryReaderAccessKeyID:  registryReaderAccessKeyID,
			RegistryReaderSecretKey:    registryReaderSecretAccessKey,
			RegistryReaderSessionToken: registryReaderSessionToken,
			APITokenProvider:           func() string { return os.Getenv(credentials.APITokenEnv) },
			R2Endpoint:                 credentials.R2Endpoint, APIBaseURL: credentials.APIBaseURL,
		})
	case "gcp-local":
		return publisher.NewLocalGCSBackend(config.GCSLocal.Endpoint, config.GCSLocal.Bucket)
	default:
		return nil, fmt.Errorf("unsupported deployment provider %q", config.Provider)
	}
}

func writeRootUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Artifact Pages CLI")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages <command>")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Commands:")
	fmt.Fprintln(writer, "  index build   Build a site index without copying or publishing artifacts")
	fmt.Fprintln(writer, "  app deploy    Deploy a versioned SPA bundle to a static hosting origin")
	fmt.Fprintln(writer, "  site publish  Build and publish one site's artifacts and index")
	fmt.Fprintln(writer, "  preview publish  Build and publish one explicit site's review preview")
	fmt.Fprintln(writer, "  registry register  Reconcile the Git-owned site registrations")
	fmt.Fprintln(writer, "  registry unregister  Remove a site's registration and stored projection")
	fmt.Fprintln(writer, "  config set-default  Save the user's default deployment config locator")
	fmt.Fprintln(writer, "  lock inspect|recover  Inspect or guardedly recover a site lock")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Run a command with --help for options.")
	fmt.Fprintln(writer, "Default deployment config: artifact-pages.yaml (--config and ARTIFACT_PAGES_CONFIG take precedence).")
}

func writeLockUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages lock inspect --site ID|--scope registry [--config LOCATOR ...] [--format text|json]")
	fmt.Fprintln(writer, "  artifact-pages lock recover --site ID|--scope registry --observed-etag ETAG [--config LOCATOR ...] [--format text|json]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Inspect a retained site lock or compare-and-swap a confirmed stale lock to free.")
}

func writeLockCommandUsage(writer io.Writer, command string) {
	if command == "inspect" {
		fmt.Fprintln(writer, "Usage: artifact-pages lock inspect --site ID|--scope registry [--config LOCATOR ...] [--format text|json]")
		return
	}
	fmt.Fprintln(writer, "Usage: artifact-pages lock recover --site ID|--scope registry --observed-etag ETAG [--config LOCATOR ...] [--format text|json]")
}

func writeIndexUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages index build [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Build site discovery metadata and an artifact index from ready-to-serve HTML and Markdown documents.")
}

func writeBuildUsage(writer io.Writer) {
	writeIndexUsage(writer)
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Options:")
	fmt.Fprintln(writer, "  --site ID              required site identifier")
	fmt.Fprintln(writer, "  --site-title TITLE     site display title")
	fmt.Fprintln(writer, "  --source DIR           publishable static content directory (relative to the current directory)")
	fmt.Fprintln(writer, "  --out DIR              output root (default .local/storage)")
	fmt.Fprintln(writer, "  --repository NAME      override repository name inferred from origin")
	fmt.Fprintln(writer, "  --repository-url URL   override repository URL inferred from origin")
	fmt.Fprintln(writer, "  --ref REF              override the current branch or commit")
}

func writeAppUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages app deploy [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Deploy the versioned web application using the configured provider target.")
}

func writeAppDeployUsage(writer io.Writer) {
	writeAppUsage(writer)
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Options:")
	fmt.Fprintln(writer, "  --archive FILE          verified local web release archive (.tar.gz)")
	fmt.Fprintln(writer, "  --version VERSION       download and deploy a published GitHub release")
	fmt.Fprintln(writer, "  --repository OWNER/REPO GitHub release repository (default tasuku43/git-artifact-pages)")
	fmt.Fprintln(writer, "  --config LOCATOR        deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	fmt.Fprintln(writer, "  --dry-run               show planned changes without writes, deletes, lock recovery, or cache changes")
	fmt.Fprintln(writer, "  --format text|json      output a human-readable result or stable JSON")
}

func writeSiteUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages site publish [options]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Build the site index and publish one selected site's static projection.")
	fmt.Fprintln(writer, "Default deployment config: artifact-pages.yaml (--config and ARTIFACT_PAGES_CONFIG take precedence).")
}

func writeSitePublishUsage(writer io.Writer) {
	writeSiteUsage(writer)
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Options:")
	fmt.Fprintln(writer, "  --site ID               required site identifier")
	fmt.Fprintln(writer, "  --source DIR            publishable static content directory (defaults to the registered sourcePath)")
	fmt.Fprintln(writer, "  --config LOCATOR        deployment config path or github:// locator (repeatable; later layers override earlier ones)")
	fmt.Fprintln(writer, "  --dry-run               show origin changes and stale preview references without writes, deletes, lock recovery, or cache changes")
	fmt.Fprintln(writer, "  --format text|json      output a human-readable result or stable JSON")
}

func writeConfigUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages config set-default LOCATOR")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Save a local path or github://OWNER/REPO/FILE?ref=REF deployment config locator.")
}

func writeRegistryUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages registry register [--config LOCATOR ...] [--dry-run] [--format text|json]")
	fmt.Fprintln(writer, "  artifact-pages registry unregister --site ID [--config LOCATOR ...] [--dry-run] [--format text|json]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Reconcile the complete site set declared in the selected deployment config.")
}

func writeRegistryRegisterUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages registry register [--config LOCATOR ...] [--dry-run] [--format text|json]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Reconcile the sites mapping in the selected config; sites omitted from it are unregistered and cleaned on apply.")
}

func writeRegistryUnregisterUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages registry unregister --site ID [--config LOCATOR ...] [--dry-run] [--format text|json]")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Remove the site from the selected config's sites mapping, then clean its deployed prefixes and cache paths.")
}
