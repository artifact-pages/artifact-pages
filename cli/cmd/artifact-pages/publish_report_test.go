package main

import (
	"bytes"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

func TestSitePublishReportStates(t *testing.T) {
	resolved := deploymentconfig.ResolvedConfig{Config: deploymentconfig.DeploymentConfig{
		Provider: "local", Local: &deploymentconfig.LocalTarget{Root: ".local/public-site/storage"},
	}}
	for _, test := range []struct {
		name, outcome, status, footer string
		dry                           bool
	}{
		{"dry run", "planned", "DRY RUN", "Dry run complete. No writes.", true},
		{"dry run no-op", "no-op", "DRY RUN", "Dry run complete. No writes.", true},
		{"published", "published", "PUBLISHED", "Synced 2 files · removed 1 stale files.", false},
		{"no-op", "no-op", "UP TO DATE", "Everything is up to date.", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			result := publisher.Result{Site: "ja", Outcome: test.outcome}
			if test.outcome != "no-op" {
				result.Changes = []publisher.Change{
					{Action: "update", Path: "_indexes/ja/index.json"},
					{Action: "remove", Path: "_artifacts/ja/old.css"},
					{Action: "create", Path: "_artifacts/ja/guide.md"},
				}
				result.FilesPublished, result.FilesRemoved = 2, 1
			}
			original := append([]publisher.Change(nil), result.Changes...)
			var output bytes.Buffer
			writeSitePublishReport(&output, result, resolved, test.dry, false)
			text := output.String()
			for _, expected := range []string{"site publish ja  " + test.status, "Target    local · .local/public-site/storage", test.footer} {
				if !strings.Contains(text, expected) {
					t.Errorf("missing %q in:\n%s", expected, text)
				}
			}
			if strings.Contains(text, "\x1b") || strings.Contains(text, "Preview catalog:") {
				t.Fatalf("plain report includes ANSI or empty preview section: %q", text)
			}
			if !reflect.DeepEqual(result.Changes, original) {
				t.Fatal("rendering mutated result changes")
			}
			if test.outcome != "no-op" {
				for _, expected := range []string{"Artifacts · _artifacts/ja/", "+ create  guide.md", "- remove  old.css", "Indexes · _indexes/ja/", "~ update  index.json"} {
					if !strings.Contains(text, expected) {
						t.Errorf("missing %q in:\n%s", expected, text)
					}
				}
			}
		})
	}
}

func TestSitePublishReportBoundedAndSafe(t *testing.T) {
	result := publisher.Result{Site: "ja", Outcome: "planned"}
	for i := 0; i < 100; i++ {
		result.Changes = append(result.Changes, publisher.Change{Action: "create", Path: fmt.Sprintf("_artifacts/ja/%03d.md", i)})
	}
	result.Changes[0].Path = "_artifacts/ja/000\x1b[31m\n.md"
	result.Changes = append(result.Changes, publisher.Change{Action: "update", Path: "_indexes/ja/meta.json"})
	previewChanges := []preview.CatalogReconciliationChange{{Action: "remove"}, {Action: "keep"}}
	result.PreviewChanges = &previewChanges
	var output bytes.Buffer
	writeSitePublishReport(&output, result, deploymentconfig.ResolvedConfig{}, true, false)
	text := output.String()
	for _, expected := range []string{"+ 100 create", "88 more; use --format json", "meta.json", "1 stale references to prune · 1 groups retained"} {
		if !strings.Contains(text, expected) {
			t.Errorf("missing %q: %s", expected, text)
		}
	}
	if strings.Contains(text, "\x1b") || strings.Contains(text, "099.md") {
		t.Fatal("unbounded or unsafe report")
	}
	if len(result.Changes) != 101 {
		t.Fatal("report truncated the underlying JSON result")
	}
}

func TestSitePublishReportCacheOnlyRetry(t *testing.T) {
	for _, dry := range []bool{true, false} {
		var output bytes.Buffer
		result := publisher.Result{Site: "guide", Outcome: "published", InvalidationPaths: []string{"/_artifacts/guide/report.html"}}
		verb := "planned"
		if !dry {
			verb = "requested"
			result.InvalidationID = "purge-request-123"
		}
		writeSitePublishReport(&output, result, deploymentconfig.ResolvedConfig{}, dry, false)
		if !strings.Contains(output.String(), "Cache revalidation: 1 paths "+verb) || strings.Contains(output.String(), "Everything is up to date") {
			t.Fatalf("cache-only report = %s", output.String())
		}
		if !dry && !strings.Contains(output.String(), "Request   purge-request-123") {
			t.Fatal("cache request ID missing")
		}
	}
}

func TestReportColorPolicy(t *testing.T) {
	var output bytes.Buffer
	t.Setenv("TERM", "xterm-256color")
	if terminalColor(&output) {
		t.Fatal("redirected output must be plain")
	}
	t.Setenv("NO_COLOR", "")
	if terminalColor(os.Stdout) {
		t.Fatal("NO_COLOR must disable colors even when empty")
	}
	if got := reportTone("~", "update", true); got != "\x1b[38;2;197;185;159m~\x1b[0m" {
		t.Fatalf("unexpected palette: %q", got)
	}
	if reportTone("~", "update", false) != "~" {
		t.Fatal("plain mode changed marker")
	}
}
