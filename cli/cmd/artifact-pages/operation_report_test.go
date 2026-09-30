package main

import (
	"bytes"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	deploymentconfig "github.com/tasuku43/git-artifact-pages/cli/internal/config"
	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
	"github.com/tasuku43/git-artifact-pages/cli/internal/publisher"
)

func TestDeploymentReports(t *testing.T) {
	updated := true
	config := deploymentconfig.ResolvedConfig{Config: deploymentconfig.DeploymentConfig{Provider: "cloudflare", Cloudflare: &deploymentconfig.CloudflareTarget{Bucket: "artifact-pages", AccountID: "0123456789abcdef0123456789abcdef"}}}
	for _, test := range []struct {
		name   string
		result publisher.Result
		dry    bool
		want   []string
	}{
		{"register plan", publisher.Result{Operation: "registry register", Outcome: "planned", RegistryUpdated: &updated, Changes: []publisher.Change{{Action: "create", Path: "_indexes/sites.json#sites/guide"}, {Action: "update", Path: "_indexes/sites.json"}, {Action: "invalidate", Path: "/_indexes/sites.json"}}}, true, []string{"registry register  DRY RUN", "+ 1 create", "~ 1 update", "1 invalidate", "Site registrations", "Registry projection", "Cache revalidation", "will update", "No writes."}},
		{"register", publisher.Result{Operation: "registry register", Outcome: "registered"}, false, []string{"registry register  REGISTERED", "reconciliation complete"}},
		{"unregister", publisher.Result{Operation: "registry unregister", Site: "retired", Outcome: "unregistered", FilesRemoved: 1, Changes: []publisher.Change{{Action: "remove", Path: "_artifacts/retired/page.html"}}}, false, []string{"registry unregister retired  UNREGISTERED", "Site cleanup", "1 objects removed"}},
		{"app", publisher.Result{Operation: "app deploy", Version: "1.2.3", Outcome: "deployed", FilesPublished: 1, InvalidationID: "request-id", Changes: []publisher.Change{{Action: "create", Path: "index.html"}}}, false, []string{"app deploy 1.2.3  DEPLOYED", "Application files", "request-id", "Deployed 1 application files"}},
		{"no-op", publisher.Result{Operation: "registry register", Outcome: "no-op"}, false, []string{"UP TO DATE", "Everything is up to date"}},
		{"dry no-op", publisher.Result{Operation: "app deploy", Outcome: "no-op"}, true, []string{"DRY RUN", "No writes."}},
		{"inspect", publisher.Result{Operation: "lock inspect", Site: "registry", Outcome: "inspected", Lock: &publisher.LockSnapshot{State: "held", Owner: "owner-1", ETag: `"exact-etag"`, AcquiredAt: time.Unix(0, 0).UTC()}}, false, []string{"lock inspect registry  INSPECTED", "held", `"exact-etag"`, "owner-1", "1970-01-01T00:00:00Z", "No writes."}},
		{"recover", publisher.Result{Operation: "lock recover", Site: "guide", Outcome: "recovered", Lock: &publisher.LockSnapshot{State: "free", ETag: "new-etag"}}, false, []string{"RECOVERED", "free", "new-etag", "fresh inspection"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			original := append([]publisher.Change(nil), test.result.Changes...)
			var output bytes.Buffer
			writeDeploymentReport(&output, test.result, config, test.dry)
			for _, expected := range test.want {
				if !strings.Contains(output.String(), expected) {
					t.Errorf("missing %q in:\n%s", expected, output.String())
				}
			}
			if strings.Contains(output.String(), "\x1b") {
				t.Fatal("redirected output has ANSI")
			}
			if !reflect.DeepEqual(original, test.result.Changes) {
				t.Fatal("report mutated JSON changes")
			}
		})
	}
}

func TestOperationReportsBoundedAndSanitized(t *testing.T) {
	changes := make([]publisher.Change, 30)
	for i := range changes {
		changes[i] = publisher.Change{Action: "create", Path: fmt.Sprintf("assets/%02d.js", i)}
	}
	changes[0].Path += "\x1b[31m\n"
	var output bytes.Buffer
	reportChanges(&output, "Application files", changes)
	if !strings.Contains(output.String(), "18 more") || strings.Contains(output.String(), "\x1b") || strings.Contains(output.String(), "29.js") {
		t.Fatalf("unsafe/unbounded report: %q", output.String())
	}
}

func TestIndexAndConfigReports(t *testing.T) {
	var index bytes.Buffer
	writeIndexReport(&index, "guide", indexer.BuildResult{ArtifactsIndexed: 2, FilesScanned: 3, OutputBytes: 100, MetadataBytes: 40, Elapsed: time.Second}, ".local/guide/index.json", ".local/guide/meta.json")
	for _, value := range []string{"index build guide  BUILT", "2 artifacts", "3 files", "100 bytes", "40 bytes", "No artifacts were copied or published"} {
		if !strings.Contains(index.String(), value) {
			t.Errorf("missing %q: %s", value, index.String())
		}
	}
	var config bytes.Buffer
	writeConfigReport(&config, "github://acme/admin", "/tmp/default-config")
	for _, value := range []string{"config set-default  SAVED", "github://acme/admin", "/tmp/default-config", "No deployment changes"} {
		if !strings.Contains(config.String(), value) {
			t.Errorf("missing %q: %s", value, config.String())
		}
	}
}

func TestPreviewReports(t *testing.T) {
	for _, state := range []string{"planned", "published", "no-op", "no-preview"} {
		t.Run(state, func(t *testing.T) {
			var output bytes.Buffer
			result := previewPublishOutput{Site: "guide", Outcome: state, HeadSHA: "head-sha", PullRequestURL: "https://github.com/acme/docs/pull/42", GroupListURL: "https://example.test/guide/previews", Documents: []previewDocumentURL{{Path: "guide.md", URL: "https://example.test/guide/preview/guide.md"}}, Objects: []preview.PublicationObjectChange{{Action: "create", Path: "guide.md"}}, CatalogChanges: []preview.PublicationCatalogChange{{Action: "add", GroupID: "pr:42", Reason: "published"}}}
			printPreviewPublishReport(&output, result, deploymentconfig.ResolvedConfig{}, state == "planned")
			for _, value := range []string{"preview publish guide", "head-sha", "https://github.com/acme/docs/pull/42", "https://example.test/guide/preview/guide.md", "Preview objects", "Preview catalog"} {
				if !strings.Contains(output.String(), value) {
					t.Errorf("missing %q: %s", value, output.String())
				}
			}
			if state == "planned" && !strings.Contains(output.String(), "No writes.") {
				t.Fatal("missing dry-run assurance")
			}
			if state == "no-preview" && !strings.Contains(output.String(), "No preview was published") {
				t.Fatal("no-preview incorrectly implies publishing")
			}
		})
	}
}

func TestPreviewDocumentURLsBounded(t *testing.T) {
	result := previewPublishOutput{Site: "guide", Outcome: "planned"}
	for i := 0; i < 30; i++ {
		result.Documents = append(result.Documents, previewDocumentURL{Path: fmt.Sprintf("%02d.md", i), URL: fmt.Sprintf("https://example.test/preview/%02d.md", i)})
	}
	var output bytes.Buffer
	printPreviewPublishReport(&output, result, deploymentconfig.ResolvedConfig{}, true)
	if !strings.Contains(output.String(), "18 more") || strings.Contains(output.String(), "29.md") || len(result.Documents) != 30 {
		t.Fatalf("preview report did not bound display while retaining the result: %s", output.String())
	}
}
