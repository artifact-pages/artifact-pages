package publisher

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tasuku43/git-artifact-pages/cli/internal/fulltext"
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
	if err != nil || result.Outcome != "published" {
		t.Fatalf("publish = %+v, %v", result, err)
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
	events := backend.eventSnapshot()
	manifestAt, metadataAt := -1, -1
	for i, e := range events {
		if e == "put:"+manifestKey {
			manifestAt = i
		}
		if e == "put:_indexes/sre/meta.json" {
			metadataAt = i
		}
	}
	if manifestAt < 0 || metadataAt <= manifestAt {
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
		if at < 0 || at >= manifestAt {
			t.Fatalf("blob published after manifest: %s", key)
		}
		object, _, err := backend.GetObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		if object.ContentType != "application/octet-stream" || object.ContentEncoding != "" || object.Cache != immutableCache {
			t.Fatalf("bad blob metadata: %+v", object)
		}
	}
	backend.resetEvents()
	result, err = PublishSite(context.Background(), backend, opts)
	if err != nil || result.Outcome != "no-op" {
		t.Fatalf("repeat = %+v, %v", result, err)
	}
	writePublisherFixture(t, root, "docs/artifacts/report.html", []byte("<title>First</title><p>newgeneration</p>"))
	// A partial failure must leave a retryable cache record containing search paths.
	backend.failPutKey = manifestKey
	if _, err := PublishSite(context.Background(), backend, opts); err == nil {
		t.Fatal("expected manifest write failure")
	}
	backend.failPutKey = ""
	result, err = PublishSite(context.Background(), backend, opts)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("retry = %+v, %v", result, err)
	}
	oldRoot := strings.TrimPrefix(manifest.Root.URL, "/")
	if _, _, err := backend.GetObject(context.Background(), oldRoot); err == nil {
		t.Fatal("stale root retained")
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
