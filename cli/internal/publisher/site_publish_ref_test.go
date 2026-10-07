package publisher

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
)

func TestPublishSiteRefOverrideIsMetadataOnlyAndPartOfFingerprint(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := runPublisherGitAt(root, "branch", "--move", "main"); err != nil {
		t.Fatalf("rename initial branch to main: %v", err)
	}
	backend, err := NewDirectoryBackend(t.TempDir())
	if err != nil {
		t.Fatalf("create deployment backend: %v", err)
	}
	seedDirectoryRegistry(t, backend, registeredSREManifest)

	initial, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || initial.Outcome != "synced" {
		t.Fatalf("initial site sync = %+v, err=%v; want synced", initial, err)
	}
	if got := publishedArtifactRef(t, backend, "report.html"); got != "main" {
		t.Fatalf("initial source.ref = %q, want default branch main", got)
	}

	if err := runPublisherGitAt(root, "checkout", "-b", "issue-070-pr"); err != nil {
		t.Fatalf("create PR branch: %v", err)
	}
	workflow := filepath.Join(root, ".github", "workflows", "check.yml")
	if err := os.MkdirAll(filepath.Dir(workflow), 0o755); err != nil {
		t.Fatalf("create workflow directory: %v", err)
	}
	if err := os.WriteFile(workflow, []byte("name: checks\n"), 0o600); err != nil {
		t.Fatalf("write workflow-only change: %v", err)
	}
	if err := runPublisherGitAt(root, "add", ".github/workflows/check.yml"); err != nil {
		t.Fatalf("stage workflow-only change: %v", err)
	}
	if err := runPublisherGitAt(root, "commit", "--quiet", "-m", "adjust workflow only"); err != nil {
		t.Fatalf("commit workflow-only change: %v", err)
	}

	withoutOverride, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", DryRun: true})
	if err != nil {
		t.Fatalf("site sync dry-run without ref override: %v", err)
	}
	if withoutOverride.Outcome != "planned" || !reflect.DeepEqual(withoutOverride.Changes, []Change{{Action: "update", Path: "_indexes/sre/index.json"}}) {
		t.Fatalf("workflow-only dry-run without override = %+v; want only the source.ref index update", withoutOverride)
	}

	productionRef, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Ref: "main", DryRun: true})
	if err != nil {
		t.Fatalf("site sync dry-run with production ref: %v", err)
	}
	if productionRef.Outcome != "no-op" || len(productionRef.Changes) != 0 || !productionRef.BuildSkipped {
		t.Fatalf("workflow-only dry-run with production ref = %+v; want cached no-op", productionRef)
	}

	changedRef, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Ref: "release-metadata"})
	if err != nil || changedRef.Outcome != "synced" {
		t.Fatalf("site sync with changed metadata ref = %+v, err=%v; want synced", changedRef, err)
	}
	if got := publishedArtifactRef(t, backend, "report.html"); got != "release-metadata" {
		t.Fatalf("published source.ref after changing the override = %q, want release-metadata", got)
	}
	artifact, _, err := backend.GetObject(t.Context(), "_artifacts/sre/report.html")
	if err != nil || string(artifact.Bytes) != "<title>Report</title><h1>Report</h1>" {
		t.Fatalf("artifact after ref-only publication = %q, err=%v; ref override must preserve checked-out document bytes", artifact.Bytes, err)
	}

	updatedHTML := "<title>PR report</title><h1>PR report</h1>"
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "report.html"), []byte(updatedHTML), 0o600); err != nil {
		t.Fatalf("write PR document change: %v", err)
	}
	if err := runPublisherGitAt(root, "add", "docs/artifacts/report.html"); err != nil {
		t.Fatalf("stage PR document change: %v", err)
	}
	if err := runPublisherGitAt(root, "commit", "--quiet", "-m", "edit published document"); err != nil {
		t.Fatalf("commit PR document change: %v", err)
	}
	withDocumentEdit, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Ref: "main", DryRun: true})
	if err != nil {
		t.Fatalf("site sync dry-run with document edit and production ref: %v", err)
	}
	if withDocumentEdit.Outcome != "planned" || !sitePublishHasChange(withDocumentEdit.Changes, "update", "_artifacts/sre/report.html") {
		t.Fatalf("document-edit dry-run with production ref = %+v; want the checked-out document update planned", withDocumentEdit)
	}

	withDocumentEdit, err = PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Ref: "main"})
	if err != nil || withDocumentEdit.Outcome != "synced" {
		t.Fatalf("site sync document edit with production ref = %+v, err=%v; want synced", withDocumentEdit, err)
	}
	if got := publishedArtifactRef(t, backend, "report.html"); got != "main" {
		t.Fatalf("published source.ref with the production override = %q, want main", got)
	}
	artifact, _, err = backend.GetObject(t.Context(), "_artifacts/sre/report.html")
	if err != nil || string(artifact.Bytes) != updatedHTML {
		t.Fatalf("published artifact after PR edit = %q, err=%v; want current PR checkout bytes", artifact.Bytes, err)
	}
}

func publishedArtifactRef(t *testing.T, backend ConditionalObjectBackend, path string) string {
	t.Helper()
	object, _, err := backend.GetObject(t.Context(), "_indexes/sre/index.json")
	if err != nil {
		t.Fatalf("read published site index: %v", err)
	}
	var index indexer.SiteIndex
	if err := json.Unmarshal(object.Bytes, &index); err != nil {
		t.Fatalf("decode published site index: %v", err)
	}
	for _, artifact := range index.Artifacts {
		if artifact.Path == path {
			if artifact.Source == nil {
				t.Fatalf("artifact %q has no source metadata", path)
			}
			return artifact.Source.Ref
		}
	}
	t.Fatalf("published site index has no artifact %q", path)
	return ""
}
