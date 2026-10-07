package publisher

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

func TestPublishSiteAllowsEmptyDocumentsAndRetriesPartialStaleDeletion(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	writePublisherFixture(t, root, "docs/artifacts/second.html", []byte("<title>Second</title><h1>Second</h1>"))
	writePublisherFixture(t, root, "docs/artifacts/assets/theme.css", []byte("body { color: navy; }\n"))

	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/other/keep.html", []byte("neighbor artifact"))
	seedMemoryObject(backend.lockMemoryBackend, "_indexes/other/index.json", []byte("neighbor index"))
	seedMemoryObject(backend.lockMemoryBackend, "index.html", []byte("application shell"))
	seedMemoryObject(backend.lockMemoryBackend, "_control/private/sentinel", []byte("private control data"))

	initial, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("initial PublishSite() error = %v", err)
	}
	if initial.Outcome != "synced" {
		t.Fatalf("initial PublishSite() = %+v, want published", initial)
	}

	missingPreview := previewPublishGroup("42", "0123456789abcdef0123456789abcdef01234567")
	livePreview := previewPublishGroup("43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	seedPreviewPublishCatalog(t, backend.lockMemoryBackend, []preview.Group{missingPreview, livePreview}, livePreview.HeadSHA)

	for _, relative := range []string{"docs/artifacts/report.html", "docs/artifacts/second.html"} {
		if err := os.Remove(filepath.Join(root, filepath.FromSlash(relative))); err != nil {
			t.Fatalf("remove last indexed document %q: %v", relative, err)
		}
	}
	backend.resetEvents()
	backend.partialDeleteCount = 1
	_, err = PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || err.Error() != "remove stale site objects: injected partial delete failure" {
		t.Fatalf("empty-site PublishSite() error = %v, want injected partial deletion failure", err)
	}
	remainingAfterFailure, err := backend.lockMemoryBackend.ListKeys(context.Background(), "_artifacts/sre/")
	if err != nil || len(remainingAfterFailure) != 2 {
		t.Fatalf("site artifacts after partial deletion = %v, err=%v; want retained CSS and one stale document", remainingAfterFailure, err)
	}

	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("retry empty-site PublishSite() error = %v", err)
	}
	// The current builder always publishes its full-text projection. Emptying
	// the indexed document set changes the search manifest/root blob too, in
	// addition to the index/meta rows and the two uncertain stale artifacts.
	if result.Outcome != "synced" || result.FilesPublished != 4 || result.FilesRemoved != 3 {
		t.Fatalf("retry empty-site PublishSite() = %+v, want index/meta/search updates and all uncertain stale deletes", result)
	}

	indexObject, _, err := backend.lockMemoryBackend.GetObject(context.Background(), "_indexes/sre/index.json")
	if err != nil {
		t.Fatalf("read zero-document index: %v", err)
	}
	var index struct {
		Artifacts json.RawMessage `json:"artifacts"`
	}
	if err := json.Unmarshal(indexObject.Bytes, &index); err != nil {
		t.Fatalf("decode zero-document index: %v", err)
	}
	if string(index.Artifacts) != "[]" {
		t.Errorf("empty site artifacts = %s, want []", index.Artifacts)
	}
	metadataObject, _, err := backend.lockMemoryBackend.GetObject(context.Background(), "_indexes/sre/meta.json")
	if err != nil {
		t.Fatalf("read zero-document discovery metadata: %v", err)
	}
	var metadata struct {
		ArtifactCount int `json:"artifactCount"`
	}
	if err := json.Unmarshal(metadataObject.Bytes, &metadata); err != nil {
		t.Fatalf("decode zero-document discovery metadata: %v", err)
	}
	if metadata.ArtifactCount != 0 {
		t.Errorf("empty site artifactCount = %d, want 0", metadata.ArtifactCount)
	}

	wantSiteArtifacts := []string{"_artifacts/sre/assets/theme.css"}
	if got, err := backend.lockMemoryBackend.ListKeys(context.Background(), "_artifacts/sre/"); err != nil || !reflect.DeepEqual(got, wantSiteArtifacts) {
		t.Errorf("site artifact keys after retry = %v, err=%v; want retained resource %v only", got, err, wantSiteArtifacts)
	}
	resource, _, err := backend.lockMemoryBackend.GetObject(context.Background(), wantSiteArtifacts[0])
	if err != nil || string(resource.Bytes) != "body { color: navy; }\n" {
		t.Errorf("remaining site resource = %q, err=%v", resource.Bytes, err)
	}

	for key, want := range map[string][]byte{
		"_indexes/sites.json":        mustRegistryProjection(t),
		"_artifacts/other/keep.html": []byte("neighbor artifact"),
		"_indexes/other/index.json":  []byte("neighbor index"),
		"index.html":                 []byte("application shell"),
		"_control/private/sentinel":  []byte("private control data"),
	} {
		object, _, getErr := backend.lockMemoryBackend.GetObject(context.Background(), key)
		if getErr != nil || string(object.Bytes) != string(want) {
			t.Errorf("boundary object %q = %q, err=%v; want %q", key, object.Bytes, getErr, want)
		}
	}
	previewCatalog := readPreviewPublishCatalog(t, backend.lockMemoryBackend, "sre")
	if len(previewCatalog.Groups) != 1 || previewCatalog.Groups[0].ID != livePreview.ID {
		t.Errorf("preview groups after retry = %#v, want only the live preview retained", previewCatalog.Groups)
	}
	manifestKey, err := preview.ManifestKey("sre", livePreview.HeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := backend.lockMemoryBackend.GetObject(context.Background(), providerObjectKey(manifestKey)); err != nil {
		t.Errorf("live preview manifest was not retained: %v", err)
	}
}
