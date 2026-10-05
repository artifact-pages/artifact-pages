package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

type stringList []string

func (values *stringList) String() string { return strings.Join(*values, ",") }

func (values *stringList) Set(value string) error {
	if strings.TrimSpace(value) == "" {
		return errors.New("resource path cannot be empty")
	}
	*values = append(*values, value)
	return nil
}

func main() {
	var resources stringList
	site := flag.String("site", "", "registered site ID")
	sourcePath := flag.String("source-path", "", "registered repository-relative source path")
	defaultRef := flag.String("default-ref", "", "default-branch ref used as the comparison point")
	headRef := flag.String("head-ref", "HEAD", "source revision to preview")
	previewRoot := flag.String("root", ".local/previews", "local preview output directory")
	repository := flag.String("repository", "", "registered GitHub owner/repository, required with -pull-request-url")
	pullRequestURL := flag.String("pull-request-url", "", "explicit same-repository GitHub pull request URL")
	prHeadRepository := flag.String("pull-request-head-repository", "", "PR head owner/repository, required with -pull-request-url")
	prHeadSHA := flag.String("pull-request-head-sha", "", "PR head SHA, required with -pull-request-url and equal to -head-ref")
	flag.Var(&resources, "resource", "additional repository-relative resource to include (repeatable)")
	flag.Parse()

	if *site == "" || *sourcePath == "" || *defaultRef == "" {
		fmt.Fprintln(os.Stderr, "usage: go run ./cli/cmd/preview-local -site <site> -source-path <path> -default-ref <ref> [-head-ref HEAD] [-pull-request-url <url> -repository <owner/repo> -pull-request-head-repository <owner/repo> -pull-request-head-sha <full-sha>]")
		os.Exit(2)
	}
	store, err := preview.NewDirectoryStore(*previewRoot)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	result, err := preview.BuildAndPublish(context.Background(), store, preview.BuildOptions{
		RepositoryDir:             ".",
		SiteID:                    *site,
		SourcePath:                *sourcePath,
		DefaultRef:                *defaultRef,
		HeadRef:                   *headRef,
		Repository:                *repository,
		PullRequestURL:            *pullRequestURL,
		PullRequestHeadRepository: *prHeadRepository,
		PullRequestHeadSHA:        *prHeadSHA,
		ExplicitResources:         resources,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if result.Outcome == preview.OutcomeNoPreview {
		fmt.Printf("No previewable documents remain; removed %s from %s.\n", result.Group.ID, *previewRoot)
		return
	}
	fmt.Printf("Published local preview files under %s for %s (%s).\n", *previewRoot, result.Group.ID, result.Manifest.HeadSHA)
	for _, document := range result.Manifest.Documents {
		href, err := preview.DocumentRouteHref(result.Site, result.Manifest.HeadSHA, document.Path, result.Group.ID)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Printf("http://127.0.0.1:4173%s\n", href)
	}
}
