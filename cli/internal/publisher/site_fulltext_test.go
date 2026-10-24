package publisher

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/fulltext"
)

func TestFullTextPublishOrderNoOpUpdate(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	writePublisherFixture(t, root, "docs/artifacts/second.md", []byte("# Second\n\ncache retry 再試行"))
	writePublisherFixture(t, root, "docs/artifacts/report.html", []byte("<title>First</title><p>cache retry</p>"))
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	seedMemoryObject(backend.lockMemoryBackend, "_indexes/other/search/keep.gz", []byte("neighbor"))
	opts := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	result, err := PublishSite(context.Background(), backend, opts)
	if err != nil || result.Outcome != "synced" {
		t.Fatalf("publish = %+v, %v", result, err)
	}
	if result.SnippetLimits != nil {
		t.Fatalf("uncapped publish reported snippet limits: %+v", result.SnippetLimits)
	}
	manifestKey := "_indexes/sre/search/manifest.json"
	obj, _, err := backend.GetObject(context.Background(), manifestKey)
	if err != nil {
		t.Fatal(err)
	}
	var manifest fulltext.Manifest
	if err := json.Unmarshal(obj.Bytes, &manifest); err != nil {
		t.Fatal(err)
	}
	refs := []fulltext.ObjectRef{manifest.Root}
	for _, ref := range manifest.Shards {
		if ref != nil {
			refs = append(refs, *ref)
		}
	}
	if manifest.Sections == nil || len(manifest.Texts) == 0 {
		t.Fatalf("search manifest has no section table or text packs: %+v", manifest)
	}
	refs = append(refs, *manifest.Sections)
	refs = append(refs, manifest.Texts...)
	events := backend.eventSnapshot()
	indexAt, manifestAt, metadataAt := -1, -1, -1
	for i, e := range events {
		if e == "put:_indexes/sre/index.json" {
			indexAt = i
		}
		if e == "put:"+manifestKey {
			manifestAt = i
		}
		if e == "put:_indexes/sre/meta.json" {
			metadataAt = i
		}
	}
	if indexAt < 0 || manifestAt <= indexAt || metadataAt <= manifestAt {
		t.Fatalf("bad publication order: %v", events)
	}
	for _, ref := range refs {
		key := strings.TrimPrefix(ref.URL, "/")
		at := -1
		for i, e := range events {
			if e == "put:"+key {
				at = i
			}
		}
		if at < 0 || at >= indexAt {
			t.Fatalf("blob published after index: %s", key)
		}
		object, _, err := backend.GetObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		if object.ContentType != "application/octet-stream" || object.ContentDisposition != "inline" || object.ContentEncoding != "" || object.Cache != cacheControl(cacheClassHashedAsset) {
			t.Fatalf("bad blob metadata: %+v", object)
		}
	}
	backend.resetEvents()
	result, err = PublishSite(context.Background(), backend, opts)
	if err != nil || result.Outcome != "no-op" || result.SnippetLimits != nil {
		t.Fatalf("repeat = %+v, %v", result, err)
	}
	oldSection := strings.TrimPrefix(manifest.Sections.URL, "/")
	oldText := strings.TrimPrefix(manifest.Texts[0].URL, "/")
	writePublisherFixture(t, root, "docs/artifacts/report.html", []byte("<title>First</title><p>newgeneration</p>"))
	// A partial failure must leave a retryable cache record containing search paths.
	backend.failPutKey = manifestKey
	if _, err := PublishSite(context.Background(), backend, opts); err == nil {
		t.Fatal("expected manifest write failure")
	}
	backend.failPutKey = ""
	result, err = PublishSite(context.Background(), backend, opts)
	if err != nil || result.Outcome != "synced" {
		t.Fatalf("retry = %+v, %v", result, err)
	}
	oldRoot := strings.TrimPrefix(manifest.Root.URL, "/")
	if _, _, err := backend.GetObject(context.Background(), oldRoot); err == nil {
		t.Fatal("stale root retained")
	}
	for _, key := range []string{oldSection, oldText} {
		if _, _, err := backend.GetObject(context.Background(), key); err == nil {
			t.Fatalf("stale search pack retained: %s", key)
		} else if err != ErrObjectNotFound {
			t.Fatalf("read stale search pack %s: %v", key, err)
		}
	}
	metadata, _, err := backend.GetObject(context.Background(), "_indexes/sre/meta.json")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(metadata.Bytes), "fullTextUrl") {
		t.Fatal("metadata lacks search pointer")
	}
	if _, _, err := backend.GetObject(context.Background(), "_indexes/other/search/keep.gz"); err != nil {
		t.Fatal("neighbor removed")
	}
}

func TestFullTextSnippetLimitsReportOnlyWhenCapped(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	opts := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	initial, err := PublishSite(context.Background(), backend, opts)
	if err != nil || initial.SnippetLimits != nil {
		t.Fatalf("uncapped publish = %+v, %v", initial, err)
	}
	writePublisherFixture(t, root, "docs/artifacts/capped.md", []byte("# Capped\n\n"+strings.Repeat("x", 262145)))
	result, err := PublishSite(context.Background(), backend, opts)
	if err != nil {
		t.Fatalf("capped publish = %+v, %v", result, err)
	}
	if result.SnippetLimits == nil || !reflect.DeepEqual(result.SnippetLimits.TruncatedDocuments, []string{"capped.md"}) ||
		result.SnippetLimits.OmittedDocuments == nil || len(result.SnippetLimits.OmittedDocuments) != 0 {
		t.Fatalf("snippet limit report = %+v", result.SnippetLimits)
	}
}
