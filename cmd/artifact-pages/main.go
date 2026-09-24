package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/tasuku43/git-artifact-pages/internal/indexer"
)

func main() {
	if err := run(context.Background(), os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		writeRootUsage(stdout)
		return nil
	}
	if args[0] != "index" {
		writeRootUsage(stderr)
		return fmt.Errorf("unknown command %q", args[0])
	}
	if len(args) == 1 || args[1] == "--help" || args[1] == "-h" {
		writeIndexUsage(stdout)
		return nil
	}
	if args[1] != "build" {
		writeIndexUsage(stderr)
		return fmt.Errorf("unknown index command %q", args[1])
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
		return err
	}
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected arguments: %v", flags.Args())
	}
	if *siteID == "" {
		return errors.New("--site is required")
	}
	if *sourceDir == "" {
		return errors.New("--source is required")
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

func writeRootUsage(writer io.Writer) {
	fmt.Fprintln(writer, "Artifact Pages CLI")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Usage:")
	fmt.Fprintln(writer, "  artifact-pages <command>")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Commands:")
	fmt.Fprintln(writer, "  index build   Build a site index without copying or publishing artifacts")
	fmt.Fprintln(writer, "")
	fmt.Fprintln(writer, "Run 'artifact-pages index build --help' for build options.")
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
