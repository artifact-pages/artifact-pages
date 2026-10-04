package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type siteCacheCloudflareBackend struct {
	*lockMemoryBackend
	cache *cloudflareBackend
}

func (b *siteCacheCloudflareBackend) ValidateInvalidation(paths []string) error {
	return b.cache.ValidateInvalidation(paths)
}

func (b *siteCacheCloudflareBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	return b.cache.Invalidate(ctx, paths)
}

func TestSitePublishSendsChangedURLsThroughCloudflarePurgeAPI(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	writePublisherFixture(t, root, "docs/artifacts/theme.css", []byte("body{color:blue}"))
	var files []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string][]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if len(payload["prefixes"]) != 0 {
			t.Error("site publish used broad prefix purge")
		}
		files = append(files, payload["files"]...)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true,"result":{"id":"site-purge-123"}}`))
	}))
	defer server.Close()
	b := &siteCacheCloudflareBackend{lockMemoryBackend: newLockMemoryBackend(), cache: cloudflareBackendForTest(server)}
	seedPublisherRegistry(t, b.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	result, err := PublishSite(t.Context(), b, options)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"https://pages.example.com/_artifacts/sre/report.html", "https://pages.example.com/_artifacts/sre/theme.css", "https://pages.example.com/_indexes/sre/index.json", "https://pages.example.com/_indexes/sre/meta.json", "https://pages.example.com/_indexes/sre/search/manifest.json", "https://pages.example.com/_indexes/sre/search/root-cf5183cfaf5039411cc19f752b0871c26892c185ac628400997f347085e3da90.gz"}
	if result.InvalidationID != "site-purge-123" || !reflect.DeepEqual(files, want) {
		t.Fatalf("Cloudflare site purge = %v, %+v", files, result)
	}
	files = nil
	writePublisherFixture(t, root, "docs/artifacts/theme.css", []byte("body{color:red}"))
	result, err = PublishSite(t.Context(), b, options)
	if err != nil {
		t.Fatal(err)
	}
	// Depending on generated timestamps, index bytes may remain unchanged.
	// The unchanged HTML must never be purged; the changed CSS always must.
	want = nil
	for _, p := range result.InvalidationPaths {
		want = append(want, "https://pages.example.com"+p)
	}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("resource-only change purged %v, want %v", files, want)
	}
	if len(files) == 0 || files[0] != "https://pages.example.com/_artifacts/sre/theme.css" {
		t.Fatalf("changed CSS not purged or unchanged HTML purged: %v", files)
	}
}

type siteCacheTestBackend struct {
	*siteReconcileBackend
	failInvalidate bool
	failClear      bool
	validationErr  error
	requests       [][]string
}

func (b *siteCacheTestBackend) ValidateInvalidation(paths []string) error {
	if len(paths) > 0 {
		return b.validationErr
	}
	return nil
}

func (b *siteCacheTestBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	b.requests = append(b.requests, append([]string(nil), paths...))
	if _, exists := b.objects[siteCacheRetryKey("sre")]; !exists {
		return "", errors.New("retry record missing during purge")
	}
	if b.failInvalidate {
		return "", errors.New("injected purge failure")
	}
	return b.lockMemoryBackend.Invalidate(ctx, paths)
}

func (b *siteCacheTestBackend) DeleteObjects(ctx context.Context, keys []string) error {
	if b.failClear && len(keys) == 1 && keys[0] == siteCacheRetryKey("sre") {
		return errors.New("injected retry cleanup failure")
	}
	return b.siteReconcileBackend.DeleteObjects(ctx, keys)
}

func TestSitePublishCacheRequestsAndRetry(t *testing.T) {
	for _, failure := range []string{"purge", "clear"} {
		t.Run(failure, func(t *testing.T) {
			createPublisherCheckout(t, "git@github.com:acme/sre.git")
			b := &siteCacheTestBackend{siteReconcileBackend: newSiteReconcileBackend()}
			seedPublisherRegistry(t, b.lockMemoryBackend, registeredSREManifest)
			seedMemoryObject(b.lockMemoryBackend, "_artifacts/sre/deleted.css", []byte("old"))
			options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
			options.DryRun = true
			plan, err := PublishSite(t.Context(), b, options)
			if err != nil {
				t.Fatal(err)
			}
			want := []string{"/_artifacts/sre/deleted.css", "/_artifacts/sre/report.html", "/_indexes/sre/index.json", "/_indexes/sre/meta.json", "/_indexes/sre/search/manifest.json", "/_indexes/sre/search/root-cf5183cfaf5039411cc19f752b0871c26892c185ac628400997f347085e3da90.gz"}
			if !reflect.DeepEqual(plan.InvalidationPaths, want) || len(b.requests) != 0 {
				t.Fatalf("dry run = %+v, requests=%v", plan, b.requests)
			}
			if _, exists := b.objects[siteCacheRetryKey("sre")]; exists {
				t.Fatal("dry run saved retry record")
			}
			options.DryRun = false
			b.failInvalidate, b.failClear = failure == "purge", failure == "clear"
			if _, err := PublishSite(t.Context(), b, options); err == nil {
				t.Fatal("injected cache failure succeeded")
			}
			if _, exists := b.objects[siteCacheRetryKey("sre")]; !exists {
				t.Fatal("failure lost pending cache paths")
			}
			options.DryRun = true
			plan, err = PublishSite(t.Context(), b, options)
			if err != nil || plan.Outcome != "planned" || len(plan.Changes) != 0 || !reflect.DeepEqual(plan.InvalidationPaths, want) {
				t.Fatalf("retry dry run = %+v, %v", plan, err)
			}
			b.failInvalidate, b.failClear, options.DryRun = false, false, false
			b.resetEvents()
			result, err := PublishSite(t.Context(), b, options)
			if err != nil || result.Outcome != "published" || result.FilesPublished != 0 || result.InvalidationID == "" {
				t.Fatalf("cache-only retry = %+v, %v", result, err)
			}
			if !reflect.DeepEqual(b.requests[len(b.requests)-1], want) {
				t.Fatalf("retry forgot deleted URLs: %v", b.requests)
			}
			if _, exists := b.objects[siteCacheRetryKey("sre")]; exists {
				t.Fatal("successful retry retained record")
			}
			before := len(b.requests)
			result, err = PublishSite(t.Context(), b, options)
			if err != nil || result.Outcome != "no-op" || len(b.requests) != before {
				t.Fatalf("no-op = %+v, %v; requests=%v", result, err, b.requests)
			}
		})
	}
}

func TestSitePublishCachePreflightBeforeOriginChanges(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	b := &siteCacheTestBackend{siteReconcileBackend: newSiteReconcileBackend(), validationErr: errors.New("missing cache credential")}
	seedPublisherRegistry(t, b.lockMemoryBackend, registeredSREManifest)
	_, err := PublishSite(t.Context(), b, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || !strings.Contains(err.Error(), "missing cache credential") {
		t.Fatalf("preflight error = %v", err)
	}
	for key := range b.objects {
		if strings.HasPrefix(key, "_artifacts/") || strings.HasPrefix(key, "_indexes/sre/") || key == siteCacheRetryKey("sre") {
			t.Fatalf("preflight mutated %s", key)
		}
	}
}

func TestSiteCacheRetrySurvivesPartialOriginWritesAndNewSource(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	b := &siteCacheTestBackend{siteReconcileBackend: newSiteReconcileBackend()}
	seedPublisherRegistry(t, b.lockMemoryBackend, registeredSREManifest)
	b.failPutKey = "_indexes/sre/meta.json"
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	if _, err := PublishSite(t.Context(), b, options); err == nil {
		t.Fatal("partial upload succeeded")
	}
	if len(b.requests) != 0 {
		t.Fatal("invalidation requested before projection finished")
	}
	// The next source can differ; never discard cache work from the failed run.
	writePublisherFixture(t, root, "docs/artifacts/new.css", []byte("body{color:blue}"))
	result, err := PublishSite(t.Context(), b, options)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/_artifacts/sre/report.html", "/_artifacts/sre/new.css", "/_indexes/sre/index.json", "/_indexes/sre/meta.json"} {
		found := false
		for _, got := range result.InvalidationPaths {
			if p == got {
				found = true
			}
		}
		if !found {
			t.Fatalf("retry lost %s: %v", p, result.InvalidationPaths)
		}
	}
}

func TestUnregisterClearsPendingSiteCacheRetryOnlyForSelectedSite(t *testing.T) {
	b := newLockMemoryBackend()
	seedPublisherRegistry(t, b, registeredSREAndDocsManifest)
	if err := writeSiteCacheRetry(t.Context(), b, "sre", []string{"/_artifacts/sre/gone.html"}, ""); err != nil {
		t.Fatal(err)
	}
	if err := writeSiteCacheRetry(t.Context(), b, "docs", []string{"/_artifacts/docs/keep.html"}, ""); err != nil {
		t.Fatal(err)
	}
	desired := testRegistryProjection(t, registeredSREAndDocsManifest)
	desired.Sites = desired.Sites[:1] // Entries are sorted: keep docs, remove sre.
	_, err := UnregisterSite(t.Context(), b, desired, "sre", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := b.objects[siteCacheRetryKey("sre")]; exists {
		t.Fatal("unregister retained pending cache record")
	}
	if _, exists := b.objects[siteCacheRetryKey("docs")]; !exists {
		t.Fatal("unregister deleted another site's retry record")
	}
}

func TestSiteCachePathsEncodeSpecialFilenamesAndStaySiteScoped(t *testing.T) {
	got := siteCachePaths("sre", []Change{{Action: "update", Path: "_artifacts/sre/日本語 #?%*.html"}}, nil, nil)
	want := []string{"/_artifacts/sre/%E6%97%A5%E6%9C%AC%E8%AA%9E%20%23%3F%25%2A.html"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("paths = %v, want %v", got, want)
	}
	b := newLockMemoryBackend()
	if err := writeSiteCacheRetry(t.Context(), b, "sre", got, ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := readSiteCacheRetry(t.Context(), b, "sre"); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{"/*", "/_artifacts/other/file.html", "/_artifacts/sre/../other/file.html", "/_artifacts/sre/%2E%2E/file.html"} {
		seedMemoryObject(b, siteCacheRetryKey("sre"), []byte(`{"schemaVersion":1,"paths":["`+p+`"]}`))
		if _, _, err := readSiteCacheRetry(t.Context(), b, "sre"); err == nil {
			t.Fatalf("accepted unsafe pending path %q", p)
		}
	}
}
