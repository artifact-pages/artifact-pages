package preview

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func shallowPreviewOrigin(t *testing.T) (origin, previewSHA string) {
	t.Helper()
	origin = newDependencyRepository(t) // leaves the preview branch checked out
	writeTestFile(t, origin, "site/d.md", "# D changed in the PR\n")
	gitTest(t, origin, "commit", "-qam", "pr: change d")
	writeTestFile(t, origin, "site/assets/base.css", "p{margin:1px}\n") // dependency via theme.css -> b.html
	gitTest(t, origin, "commit", "-qam", "pr: change base.css")
	previewSHA = gitTest(t, origin, "rev-parse", "HEAD")
	gitTest(t, origin, "checkout", "-q", "main")
	for index := 0; index < 60; index++ {
		// The default branch changes a document and a stylesheet the PR never touched.
		writeTestFile(t, origin, "site/c.md", fmt.Sprintf("# C main-only %d\n\n![pic](img/pic.png)\n", index))
		gitTest(t, origin, "commit", "-qam", fmt.Sprintf("main %d", index))
	}
	return origin, previewSHA
}

func previewSummary(result BuildResult) map[string]any {
	documents := map[string]string{}
	for _, document := range result.Group.Documents {
		documents[document.Path] = fmt.Sprintf("%s %v", document.Reason, document.ChangedResources)
	}
	return map[string]any{"outcome": result.Outcome, "documents": documents, "mergeBase": result.Manifest.MergeBase}
}

func TestBuildFromGitShallowCloneSelectsLikeFullClone(t *testing.T) {
	origin, previewSHA := shallowPreviewOrigin(t)
	options := func(repo, defaultRef, head string) BuildOptions {
		return BuildOptions{RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: defaultRef, HeadRef: head,
			Now: func() time.Time { return time.Date(2026, 9, 27, 1, 2, 3, 0, time.UTC) }}
	}
	fullClone := filepath.Join(t.TempDir(), "full")
	gitTest(t, ".", "clone", "-q", "--no-local", "file://"+origin, fullClone)
	want, err := BuildFromGit(context.Background(), options(fullClone, "origin/main", previewSHA))
	if err != nil {
		t.Fatal(err)
	}
	if want.Outcome == OutcomeNoPreview || len(want.Group.Documents) == 0 {
		t.Fatalf("fixture produced no preview: %#v", previewSummary(want))
	}

	cases := map[string]func(t *testing.T) (repo, head string){
		// The Action's checkout: depth-1 head, nothing else fetched.
		"head only": func(t *testing.T) (string, string) {
			repo := filepath.Join(t.TempDir(), "shallow")
			gitTest(t, ".", "clone", "-q", "--no-local", "--depth=1", "--branch", "preview", "file://"+origin, repo)
			return repo, "HEAD"
		},
		// Head SHA absent entirely: resolved by fetching the SHA.
		"missing head sha": func(t *testing.T) (string, string) {
			repo := filepath.Join(t.TempDir(), "shallow")
			gitTest(t, ".", "clone", "-q", "--no-local", "--depth=1", "--branch", "main", "file://"+origin, repo)
			return repo, previewSHA
		},
		// Both refs present at depth 1 with no common history visible.
		"both depth one": func(t *testing.T) (string, string) {
			repo := filepath.Join(t.TempDir(), "shallow")
			gitTest(t, ".", "clone", "-q", "--no-local", "--depth=1", "--branch", "preview", "file://"+origin, repo)
			gitTest(t, repo, "fetch", "-q", "--depth=1", "origin", "+refs/heads/main:refs/remotes/origin/main")
			return repo, "HEAD"
		},
	}
	for name, setup := range cases {
		t.Run(name, func(t *testing.T) {
			repo, head := setup(t)
			if gitTest(t, repo, "rev-parse", "--is-shallow-repository") != "true" {
				t.Fatal("fixture clone is not shallow")
			}
			got, err := BuildFromGit(context.Background(), options(repo, "origin/main", head))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(previewSummary(got), previewSummary(want)) {
				t.Fatalf("shallow selection = %#v\nfull selection    = %#v", previewSummary(got), previewSummary(want))
			}
			if got.Group.HeadSHA != want.Group.HeadSHA || got.Manifest.DefaultHead != want.Manifest.DefaultHead {
				t.Fatalf("head/default provenance differs: %s/%s vs %s/%s", got.Group.HeadSHA, got.Manifest.DefaultHead, want.Group.HeadSHA, want.Manifest.DefaultHead)
			}
			if reasons := documentReasons(got); reasons["c.md"] != "" {
				t.Fatalf("main-only change to c.md was selected: %v", reasons)
			}
		})
	}
}
