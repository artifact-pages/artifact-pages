package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"testing"
)

func TestContentTypeUsesDeterministicArtifactExtensionMap(t *testing.T) {
	tests := []struct {
		path string
		want string
	}{
		{"LICENSE", "text/plain; charset=utf-8"},
		{"THIRD_PARTY_NOTICES.txt", "text/plain; charset=utf-8"},
		{"report.HTML", "text/html; charset=utf-8"},
		{"report.htm", "text/html; charset=utf-8"},
		{"report.MD", "text/markdown; charset=utf-8"},
		{"report.markdown", "text/markdown; charset=utf-8"},
		{"style.css", "text/css; charset=utf-8"},
		{"app.js", "text/javascript; charset=utf-8"},
		{"app.mjs", "text/javascript; charset=utf-8"},
		{"app.CJS", "text/javascript; charset=utf-8"},
		{"source.json", "application/json; charset=utf-8"},
		{"source.MAP", "application/json; charset=utf-8"},
		{"site.webmanifest", "application/manifest+json; charset=utf-8"},
		{"image.svg", "image/svg+xml; charset=utf-8"},
		{"image.PNG", "image/png"},
		{"image.jpg", "image/jpeg"},
		{"image.jpeg", "image/jpeg"},
		{"image.gif", "image/gif"},
		{"image.webp", "image/webp"},
		{"image.avif", "image/avif"},
		{"image.ico", "image/vnd.microsoft.icon"},
		{"font.woff", "font/woff"},
		{"font.woff2", "font/woff2"},
		{"font.ttf", "font/ttf"},
		{"font.otf", "font/otf"},
		{"report.pdf", "application/pdf"},
		{"module.wasm", "application/wasm"},
		{"unknown.extension", "application/octet-stream"},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			if got := contentType(test.path); got != test.want {
				t.Errorf("contentType(%q) = %q, want %q", test.path, got, test.want)
			}
		})
	}
}

func TestPublishSitePreservesFilesMetadataOrderAndPrefixBoundaries(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	files := map[string][]byte{
		"assets/theme.css":     []byte("body{color:#123}\x00"),
		"assets/Logo mark.SVG": []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"/>"),
		"assets/app.CJS":       []byte("module.exports = 1;"),
		"assets/icon.PNG":      {0x89, 'P', 'N', 'G', 0x00, 0xff},
		"data/payload.avif":    {0, 0xff, 1, 0x80},
		"guide.md":             []byte("# Guide\n"),
		"日本語 #1.html":          []byte("<title>日本語</title><h1>Guide</h1>"),
	}
	for relative, contents := range files {
		writePublisherFixture(t, root, filepath.Join("docs", "artifacts", filepath.FromSlash(relative)), contents)
	}
	writePublisherFixture(t, root, filepath.Join("docs", "artifacts", "gitfile", ".git"), []byte("gitdir: ../../.git/worktrees/site"))
	writePublisherFixture(t, root, filepath.Join("docs", "artifacts", "gitdir", ".git", "objects", "ignored"), []byte("git metadata"))

	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	seedReconcileObject(t, backend.lockMemoryBackend, "_artifacts/sre/stale.txt", Object{Bytes: []byte("old")})
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/other/keep.html", []byte("other site"))
	seedMemoryObject(backend.lockMemoryBackend, "index.html", []byte("application shell"))
	seedMemoryObject(backend.lockMemoryBackend, "_control/private/sentinel", []byte("private control data"))

	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("PublishSite() error = %v", err)
	}
	if result.Outcome != "published" || result.FilesPublished != len(files)+6 || result.FilesRemoved != 1 {
		t.Fatalf("PublishSite() = %+v, want published files=%d removed=1", result, len(files)+6)
	}

	wantSourceKeys := make([]string, 0, len(files)+1)
	wantSourceKeys = append(wantSourceKeys, "_artifacts/sre/report.html")
	for relative := range files {
		wantSourceKeys = append(wantSourceKeys, "_artifacts/sre/"+filepath.ToSlash(relative))
	}
	sort.Strings(wantSourceKeys)
	events := backend.eventSnapshot()
	var putOrder []string
	firstPut, deleteIndex, lastPut := -1, -1, -1
	artifactListed, indexListed := -1, -1
	for index, event := range events {
		switch {
		case strings.HasPrefix(event, "list:"):
			if event == "list:_artifacts/sre/" && artifactListed < 0 {
				artifactListed = index
			}
			if event == "list:_indexes/sre/" && indexListed < 0 {
				indexListed = index
			}
		case strings.HasPrefix(event, "put:"):
			if firstPut < 0 {
				firstPut = index
			}
			lastPut = index
			putOrder = append(putOrder, strings.TrimPrefix(event, "put:"))
		case strings.HasPrefix(event, "delete:"):
			if strings.HasPrefix(event, "delete:_artifacts/") {
				deleteIndex = index
			}
		}
	}
	// Source and immutable search writes use bounded independent workers, so
	// their order is arbitrary inside each phase. The serial reference-bearing
	// objects must remain after both phases and in dependency order.
	generatedCount := 5 // index, search manifest, meta, and two search blobs
	if len(putOrder) != len(wantSourceKeys)+generatedCount {
		t.Fatalf("site put count = %d, want %d; order=%v events=%v", len(putOrder), len(wantSourceKeys)+generatedCount, putOrder, events)
	}
	observedSources := append([]string(nil), putOrder[:len(wantSourceKeys)]...)
	sort.Strings(observedSources)
	if strings.Join(observedSources, "\n") != strings.Join(wantSourceKeys, "\n") {
		t.Fatalf("source objects published = %v, want %v; events=%v", observedSources, wantSourceKeys, events)
	}
	generated := putOrder[len(wantSourceKeys):]
	if got := strings.Join(generated[len(generated)-3:], "\n"); got != strings.Join([]string{"_indexes/sre/index.json", "_indexes/sre/search/manifest.json", "_indexes/sre/meta.json"}, "\n") {
		t.Fatalf("reference-bearing generated objects were published in order %v; events=%v", generated[len(generated)-3:], events)
	}
	for _, key := range generated[:len(generated)-3] {
		if !strings.HasPrefix(key, "_indexes/sre/search/") || !(strings.HasSuffix(key, ".gz")) {
			t.Fatalf("immutable search phase contains unexpected key %q; events=%v", key, events)
		}
	}
	if artifactListed < 0 || indexListed < 0 || firstPut < artifactListed || firstPut < indexListed {
		t.Fatalf("both site prefixes must be listed before writes: %v", events)
	}
	if deleteIndex < 0 || deleteIndex <= lastPut || deleteIndex != len(events)-2 {
		t.Fatalf("stale deletion must follow all puts: %v", events)
	}
	if got := backend.eventSnapshot()[deleteIndex]; got != "delete:_artifacts/sre/stale.txt" {
		t.Fatalf("delete event = %q, want only the stale artifact key", got)
	}

	wantBytes := map[string][]byte{
		"_artifacts/sre/report.html": []byte("<title>Report</title><h1>Report</h1>"),
	}
	for relative, contents := range files {
		wantBytes["_artifacts/sre/"+filepath.ToSlash(relative)] = contents
	}
	wantTypes := map[string]string{
		"_artifacts/sre/report.html":          "text/html; charset=utf-8",
		"_artifacts/sre/assets/theme.css":     "text/css; charset=utf-8",
		"_artifacts/sre/assets/Logo mark.SVG": "image/svg+xml; charset=utf-8",
		"_artifacts/sre/assets/app.CJS":       "text/javascript; charset=utf-8",
		"_artifacts/sre/assets/icon.PNG":      "image/png",
		"_artifacts/sre/data/payload.avif":    "image/avif",
		"_artifacts/sre/guide.md":             "text/markdown; charset=utf-8",
		"_artifacts/sre/日本語 #1.html":          "text/html; charset=utf-8",
	}
	for key, expectedBytes := range wantBytes {
		object, exists := backend.lockMemoryBackend.objects[key]
		if !exists {
			t.Errorf("published source object %q is missing", key)
			continue
		}
		if string(object.Bytes) != string(expectedBytes) {
			t.Errorf("published bytes for %q = %v, want %v", key, object.Bytes, expectedBytes)
		}
		if object.ContentType != wantTypes[key] || object.ContentDisposition != "inline" || object.ContentEncoding != "" || object.Cache != artifactCacheControl {
			t.Errorf("published metadata for %q = type %q, disposition %q, encoding %q, cache %q", key, object.ContentType, object.ContentDisposition, object.ContentEncoding, object.Cache)
		}
		if object.Metadata["artifact-pages-sha256"] != sha256Hex(expectedBytes) {
			t.Errorf("published checksum metadata for %q = %q", key, object.Metadata["artifact-pages-sha256"])
		}
	}
	for _, key := range []string{"_indexes/sre/index.json", "_indexes/sre/meta.json"} {
		object := backend.lockMemoryBackend.objects[key]
		if object.ContentType != "application/json; charset=utf-8" || object.ContentDisposition != "inline" || object.ContentEncoding != "" || object.Cache != indexCacheControl {
			t.Errorf("generated index metadata for %q = type %q, disposition %q, encoding %q, cache %q", key, object.ContentType, object.ContentDisposition, object.ContentEncoding, object.Cache)
		}
		if key == "_indexes/sre/index.json" && !strings.Contains(string(object.Bytes), "日本語 #1.html") {
			t.Errorf("generated index did not preserve the non-ASCII source path: %s", object.Bytes)
		}
	}
	for _, key := range []string{"_artifacts/sre/gitfile/.git", "_artifacts/sre/gitdir/.git/objects/ignored", "_artifacts/sre/stale.txt"} {
		if _, exists := backend.lockMemoryBackend.objects[key]; exists {
			t.Errorf("excluded or stale object %q remains", key)
		}
	}
	for key, expected := range map[string]string{
		"_artifacts/other/keep.html": "other site",
		"index.html":                 "application shell",
		"_control/private/sentinel":  "private control data",
		"_indexes/sites.json":        string(mustRegistryProjection(t)),
	} {
		object, exists := backend.lockMemoryBackend.objects[key]
		if !exists || string(object.Bytes) != expected {
			t.Errorf("unrelated object %q = (%q, exists=%t), want unchanged %q", key, object.Bytes, exists, expected)
		}
	}
}

func TestPublishSiteAbortsBeforeWritesWhenIndexListingFails(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/sre/stale.html", []byte("stale"))
	backend.failListPrefix = "_indexes/sre/"

	_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || !strings.Contains(err.Error(), "list deployed site objects under _indexes/sre/") {
		t.Fatalf("PublishSite() error = %v, want index-prefix listing failure", err)
	}
	events := backend.eventSnapshot()
	if strings.Join(events, "\n") != "list:_artifacts/sre/\nlist:_indexes/sre/" {
		t.Fatalf("operations before failed listing = %v, want both prefix lists and no writes", events)
	}
	if got := backend.lockMemoryBackend.objects["_artifacts/sre/stale.html"]; string(got.Bytes) != "stale" {
		t.Fatalf("stale artifact after failed listing = %q, want preserved", got.Bytes)
	}
}

func TestPublishSiteRetriesAfterMetadataUploadFailureBeforeStaleDeletion(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/sre/stale.html", []byte("stale"))
	backend.failPutKey = "_indexes/sre/meta.json"

	_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Reconcile: true})
	if err == nil || !strings.Contains(err.Error(), "injected object upload failure") {
		t.Fatalf("first PublishSite() error = %v, want injected metadata upload failure", err)
	}
	if _, exists := backend.lockMemoryBackend.objects["_artifacts/sre/stale.html"]; !exists {
		t.Fatal("stale artifact was deleted before metadata upload completed")
	}
	firstEvents := backend.eventSnapshot()
	if strings.Contains(strings.Join(firstEvents, "\n"), "delete:") {
		t.Fatalf("first publish deleted stale keys after a failed upload: %v", firstEvents)
	}

	backend.resetEvents()
	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Reconcile: true})
	if err != nil {
		t.Fatalf("retry PublishSite() error = %v", err)
	}
	if result.Outcome != "published" || result.FilesRemoved != 1 {
		t.Fatalf("retry PublishSite() = %+v, want convergence and one stale removal", result)
	}
	if _, exists := backend.lockMemoryBackend.objects["_artifacts/sre/stale.html"]; exists {
		t.Fatal("retry left stale artifact behind")
	}
	if got := backend.lockMemoryBackend.objects["_indexes/sre/meta.json"].ContentType; got != "application/json; charset=utf-8" {
		t.Fatalf("meta.json Content-Type = %q", got)
	}
	if events := backend.eventSnapshot(); len(events) < 2 || events[len(events)-2] != "delete:_artifacts/sre/stale.html" || events[len(events)-1] != "delete:"+siteCacheRetryKey("sre") {
		t.Fatalf("retry operations = %v, want stale deletion last", events)
	}
}

func TestPublishSiteRetriesAfterArtifactAndIndexUploadFailures(t *testing.T) {
	tests := []struct {
		name       string
		failedKey  string
		oldContent []byte
	}{
		{
			name:       "artifact upload",
			failedKey:  "_artifacts/sre/report.html",
			oldContent: []byte("previous artifact bytes"),
		},
		{
			name:       "index replacement",
			failedKey:  "_indexes/sre/index.json",
			oldContent: []byte(`{"previous":"index"}`),
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			createPublisherCheckout(t, "git@github.com:acme/sre.git")
			backend := newSiteReconcileBackend()
			seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
			seedReconcileObject(t, backend.lockMemoryBackend, test.failedKey, Object{
				Bytes: test.oldContent, ContentType: "application/octet-stream", Cache: "no-store",
			})
			seedMemoryObject(backend.lockMemoryBackend, "_artifacts/sre/stale.html", []byte("stale"))
			backend.failPutKey = test.failedKey

			_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
			if err == nil || !strings.Contains(err.Error(), "injected object upload failure") {
				t.Fatalf("first PublishSite() error = %v, want injected failure for %s", err, test.failedKey)
			}
			firstEvents := backend.eventSnapshot()
			if !strings.Contains(strings.Join(firstEvents, "\n"), "put:"+test.failedKey) {
				t.Fatalf("first publish did not attempt the selected replacement: %v", firstEvents)
			}
			for _, event := range firstEvents {
				if strings.HasPrefix(event, "delete:") {
					t.Fatalf("first publish deleted stale content after %s failed: %v", test.name, firstEvents)
				}
			}
			if got := backend.lockMemoryBackend.objects[test.failedKey].Bytes; string(got) != string(test.oldContent) {
				t.Fatalf("object %q after failed replacement = %q, want previous bytes %q", test.failedKey, got, test.oldContent)
			}
			if _, exists := backend.lockMemoryBackend.objects["_artifacts/sre/stale.html"]; !exists {
				t.Fatalf("stale artifact was deleted before %s completed", test.name)
			}

			backend.resetEvents()
			result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
			if err != nil {
				t.Fatalf("retry PublishSite() error = %v", err)
			}
			if result.Outcome != "published" || result.FilesRemoved != 1 {
				t.Fatalf("retry PublishSite() = %+v, want successful convergence and one stale removal", result)
			}
			if got := backend.lockMemoryBackend.objects[test.failedKey].Bytes; string(got) == string(test.oldContent) {
				t.Fatalf("object %q retained previous bytes after retry: %q", test.failedKey, got)
			}
			if test.failedKey == "_artifacts/sre/report.html" {
				if got := string(backend.lockMemoryBackend.objects[test.failedKey].Bytes); got != "<title>Report</title><h1>Report</h1>" {
					t.Fatalf("artifact after retry = %q, want source bytes", got)
				}
			} else if !json.Valid(backend.lockMemoryBackend.objects[test.failedKey].Bytes) {
				t.Fatalf("index after retry is not valid JSON: %q", backend.lockMemoryBackend.objects[test.failedKey].Bytes)
			}
			if _, exists := backend.lockMemoryBackend.objects["_artifacts/sre/stale.html"]; exists {
				t.Fatal("retry left stale artifact behind")
			}
			events := backend.eventSnapshot()
			if len(events) < 2 || events[len(events)-2] != "delete:_artifacts/sre/stale.html" || events[len(events)-1] != "delete:"+siteCacheRetryKey("sre") {
				t.Fatalf("retry operations = %v, want stale deletion last", events)
			}
		})
	}
}

func TestPublishSiteRetriesPartialStaleDeletionToConvergence(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	if _, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}); err != nil {
		t.Fatalf("initial PublishSite() error = %v", err)
	}
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/sre/stale-a.html", []byte("old A"))
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/sre/stale-b.html", []byte("old B"))
	backend.resetEvents()
	backend.partialDeleteCount = 1

	_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Reconcile: true})
	if err == nil || !strings.Contains(err.Error(), "injected partial delete failure") {
		t.Fatalf("partial-delete PublishSite() error = %v, want injected failure", err)
	}
	_, firstExists := backend.lockMemoryBackend.objects["_artifacts/sre/stale-a.html"]
	_, secondExists := backend.lockMemoryBackend.objects["_artifacts/sre/stale-b.html"]
	if firstExists == secondExists {
		t.Fatalf("partial delete left stale objects (a=%t, b=%t), want exactly one remaining", firstExists, secondExists)
	}

	backend.resetEvents()
	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Reconcile: true})
	if err != nil {
		t.Fatalf("retry after partial delete error = %v", err)
	}
	if result.FilesPublished != 0 || result.FilesRemoved != 2 {
		t.Fatalf("retry after partial delete = %+v, want both uncertain stale keys replayed idempotently", result)
	}
	for _, key := range []string{"_artifacts/sre/stale-a.html", "_artifacts/sre/stale-b.html"} {
		if _, exists := backend.lockMemoryBackend.objects[key]; exists {
			t.Errorf("retry left stale object %q", key)
		}
	}
	for _, event := range backend.eventSnapshot() {
		if strings.HasPrefix(event, "put:") {
			t.Errorf("retry uploaded an already-converged object: %v", backend.eventSnapshot())
			break
		}
	}
}

func TestPublishSiteRepairsHTTPMetadataWhenBytesAlreadyMatch(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	contents := []byte("<title>Report</title><h1>Report</h1>")
	seedReconcileObject(t, backend.lockMemoryBackend, "_artifacts/sre/report.html", Object{
		Bytes: contents, ContentType: "text/plain", ContentDisposition: "attachment", ContentEncoding: "gzip",
		Cache:    "public, max-age=3600",
		Metadata: map[string]string{"artifact-pages-sha256": sha256Hex(contents)},
	})

	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("PublishSite() error = %v", err)
	}
	if result.FilesPublished != 5 {
		t.Fatalf("PublishSite() filesPublished = %d, want artifact plus index/meta metadata repair and search data", result.FilesPublished)
	}
	object := backend.lockMemoryBackend.objects["_artifacts/sre/report.html"]
	if object.ContentType != "text/html; charset=utf-8" || object.ContentDisposition != "inline" || object.ContentEncoding != "" || object.Cache != artifactCacheControl || string(object.Bytes) != string(contents) {
		t.Fatalf("repaired HTML representation = type %q, disposition %q, encoding %q, cache %q, bytes %q", object.ContentType, object.ContentDisposition, object.ContentEncoding, object.Cache, object.Bytes)
	}
}

func TestPublishSiteReconcileRepairsLocalOutOfBandBytes(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	storageRoot := filepath.Join(t.TempDir(), "storage")
	backend, err := NewDirectoryBackend(storageRoot)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutObject(context.Background(), "_indexes/sites.json", Object{Bytes: mustRegistryProjection(t)}); err != nil {
		t.Fatal(err)
	}
	options := SitePublishOptions{SiteID: "sre", SourceDir: filepath.Join(root, "docs", "artifacts")}
	if _, err := PublishSite(context.Background(), backend, options); err != nil {
		t.Fatalf("initial local PublishSite() error = %v", err)
	}
	target := filepath.Join(storageRoot, "_artifacts", "sre", "report.html")
	if err := os.WriteFile(target, []byte("out-of-band body"), 0o644); err != nil {
		t.Fatal(err)
	}
	ordinary, err := PublishSite(context.Background(), backend, options)
	if err != nil {
		t.Fatalf("normal manifest-trusting PublishSite() error = %v", err)
	}
	if ordinary.Outcome != "no-op" || !ordinary.BuildSkipped {
		t.Fatalf("normal publish after out-of-band edit = %+v, want root-matched no-op", ordinary)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "out-of-band body" {
		t.Fatalf("normal publish unexpectedly changed out-of-band object: %q, %v", got, err)
	}

	options.Reconcile = true
	result, err := PublishSite(context.Background(), backend, options)
	if err != nil {
		t.Fatalf("explicit reconcile error = %v", err)
	}
	if result.FilesPublished != 1 {
		t.Fatalf("explicit reconcile = %+v, want one repaired artifact", result)
	}
	want := []byte("<title>Report</title><h1>Report</h1>")
	if got, err := os.ReadFile(target); err != nil || !bytes.Equal(got, want) {
		t.Fatalf("reconciled object = %q, %v; want source bytes %q", got, err, want)
	}
}

func TestPublishSiteRejectsSourceSymlinksAndSpecialFilesBeforeWrites(t *testing.T) {
	tests := []struct {
		name  string
		setup func(*testing.T, string)
	}{
		{
			name: "file symlink",
			setup: func(t *testing.T, root string) {
				outside := filepath.Join(t.TempDir(), "outside.bin")
				if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(outside, filepath.Join(root, "docs", "artifacts", "linked.bin")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "git metadata symlink",
			setup: func(t *testing.T, root string) {
				outside := t.TempDir()
				if err := os.Symlink(outside, filepath.Join(root, "docs", "artifacts", ".git")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "html fifo",
			setup: func(t *testing.T, root string) {
				if err := syscall.Mkfifo(filepath.Join(root, "docs", "artifacts", "blocked.html"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "git metadata fifo",
			setup: func(t *testing.T, root string) {
				if err := syscall.Mkfifo(filepath.Join(root, "docs", "artifacts", ".git"), 0o600); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
			test.setup(t, root)
			backend := newSiteReconcileBackend()
			seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)

			_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
			if err == nil || !strings.Contains(err.Error(), "site source") {
				t.Fatalf("PublishSite() error = %v, want source-entry rejection", err)
			}
			for _, event := range backend.eventSnapshot() {
				if strings.HasPrefix(event, "put:") || strings.HasPrefix(event, "delete:") {
					t.Fatalf("invalid source performed a content mutation: %v", backend.eventSnapshot())
				}
			}
		})
	}
}

func TestPublishSiteRejectsInvalidUTF8Path(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	relative := filepath.Join("docs", "artifacts", string([]byte{'b', 'a', 'd', '-', 0xff})+".html")
	filename := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte("<h1>Bad path</h1>"), 0o600); err != nil {
		t.Skipf("filesystem does not support invalid UTF-8 names: %v", err)
	}

	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || !strings.Contains(err.Error(), "not valid UTF-8") {
		t.Fatalf("PublishSite() error = %v, want invalid UTF-8 path rejection", err)
	}
	for _, event := range backend.eventSnapshot() {
		if strings.HasPrefix(event, "put:") || strings.HasPrefix(event, "delete:") {
			t.Fatalf("invalid path performed a content mutation: %v", backend.eventSnapshot())
		}
	}
}

type siteReconcileBackend struct {
	*lockMemoryBackend
	eventsMu           sync.Mutex
	failPutMu          sync.Mutex
	events             []string
	failListPrefix     string
	failPutKey         string
	partialDeleteCount int
}

func newSiteReconcileBackend() *siteReconcileBackend {
	return &siteReconcileBackend{lockMemoryBackend: newLockMemoryBackend()}
}

func (backend *siteReconcileBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	backend.record("list:" + prefix)
	if backend.failListPrefix == prefix {
		return nil, fmt.Errorf("injected listing failure for %s", prefix)
	}
	return backend.lockMemoryBackend.ListKeys(ctx, prefix)
}

func (backend *siteReconcileBackend) PutObject(ctx context.Context, key string, object Object) error {
	backend.record("put:" + key)
	backend.failPutMu.Lock()
	failPut := backend.failPutKey == key
	if failPut {
		backend.failPutKey = ""
	}
	backend.failPutMu.Unlock()
	if failPut {
		return errors.New("injected object upload failure")
	}
	return backend.lockMemoryBackend.PutObject(ctx, key, object)
}

func (backend *siteReconcileBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.record("delete:" + strings.Join(keys, ","))
	if backend.partialDeleteCount > 0 {
		count := min(backend.partialDeleteCount, len(keys))
		backend.partialDeleteCount = 0
		if count > 0 {
			if err := backend.lockMemoryBackend.DeleteObjects(ctx, keys[:count]); err != nil {
				return err
			}
		}
		return errors.New("injected partial delete failure")
	}
	return backend.lockMemoryBackend.DeleteObjects(ctx, keys)
}

func (backend *siteReconcileBackend) eventSnapshot() []string {
	backend.eventsMu.Lock()
	defer backend.eventsMu.Unlock()
	return append([]string(nil), backend.events...)
}

func (backend *siteReconcileBackend) resetEvents() {
	backend.eventsMu.Lock()
	backend.events = nil
	backend.eventsMu.Unlock()
}

func (backend *siteReconcileBackend) record(event string) {
	backend.eventsMu.Lock()
	backend.events = append(backend.events, event)
	backend.eventsMu.Unlock()
}

func seedReconcileObject(t *testing.T, backend *lockMemoryBackend, key string, object Object) {
	t.Helper()
	backend.mu.Lock()
	defer backend.mu.Unlock()
	object.Bytes = append([]byte(nil), object.Bytes...)
	backend.objects[key] = object
	backend.etags[key] = `"seed-` + key + `"`
}

func writePublisherFixture(t *testing.T, root, relative string, contents []byte) {
	t.Helper()
	filename := filepath.Join(root, relative)
	if err := os.MkdirAll(filepath.Dir(filename), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, contents, 0o600); err != nil {
		t.Fatal(err)
	}
}

func mustRegistryProjection(t *testing.T) []byte {
	t.Helper()
	contents, _, err := testRegistryBuild(t, []byte(registeredSREManifest))
	if err != nil {
		t.Fatal(err)
	}
	return contents
}
