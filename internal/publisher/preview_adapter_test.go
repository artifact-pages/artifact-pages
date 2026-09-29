package publisher

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/internal/preview"
)

type previewAdapterFakeBackend struct {
	*lockMemoryBackend
	mu                sync.Mutex
	getFailures       map[string]error
	putFailures       map[string][]error
	listFailures      map[string]error
	putAttempts       []string
	conditionalWrites []previewAdapterConditionalWrite
	deleteCalls       [][]string
	afterGet          func(string, Object, string, error)
	afterConditional  func(string, ObjectCondition)
}

type previewAdapterConditionalWrite struct {
	key       string
	condition ObjectCondition
}

func newPreviewAdapterFakeBackend() *previewAdapterFakeBackend {
	return &previewAdapterFakeBackend{
		lockMemoryBackend: newLockMemoryBackend(),
		getFailures:       make(map[string]error),
		putFailures:       make(map[string][]error),
		listFailures:      make(map[string]error),
	}
}

func (backend *previewAdapterFakeBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	backend.mu.Lock()
	err := backend.getFailures[key]
	afterGet := backend.afterGet
	backend.mu.Unlock()
	if err != nil {
		if afterGet != nil {
			afterGet(key, Object{}, "", err)
		}
		return Object{}, "", err
	}
	object, etag, err := backend.lockMemoryBackend.GetObject(ctx, key)
	if afterGet != nil {
		afterGet(key, object, etag, err)
	}
	return object, etag, err
}

func (backend *previewAdapterFakeBackend) PutObject(ctx context.Context, key string, object Object) error {
	backend.mu.Lock()
	backend.putAttempts = append(backend.putAttempts, key)
	var err error
	if failures := backend.putFailures[key]; len(failures) > 0 {
		err = failures[0]
		backend.putFailures[key] = failures[1:]
	}
	backend.mu.Unlock()
	if err != nil {
		return err
	}
	return backend.lockMemoryBackend.PutObject(ctx, key, object)
}

func (backend *previewAdapterFakeBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	keys, err := backend.lockMemoryBackend.ListKeys(ctx, prefix)
	if err != nil {
		return nil, err
	}
	backend.mu.Lock()
	err = backend.listFailures[prefix]
	backend.mu.Unlock()
	// Deliberately return both a partial page and its error. Callers must not
	// interpret a page plus an error as a complete listing.
	if err != nil && len(keys) > 1 {
		keys = keys[:len(keys)-1]
	}
	return keys, err
}

func (backend *previewAdapterFakeBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.mu.Lock()
	backend.deleteCalls = append(backend.deleteCalls, append([]string(nil), keys...))
	backend.mu.Unlock()
	return backend.lockMemoryBackend.DeleteObjects(ctx, keys)
}

func (backend *previewAdapterFakeBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.mu.Lock()
	backend.conditionalWrites = append(backend.conditionalWrites, previewAdapterConditionalWrite{key: key, condition: condition})
	backend.mu.Unlock()
	etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	if err == nil {
		backend.mu.Lock()
		hook := backend.afterConditional
		backend.mu.Unlock()
		if hook != nil {
			hook(key, condition)
		}
	}
	return etag, err
}

func (backend *previewAdapterFakeBackend) failGet(key string, err error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.getFailures[key] = err
}

func (backend *previewAdapterFakeBackend) failNextPut(key string, err error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.putFailures[key] = append(backend.putFailures[key], err)
}

func (backend *previewAdapterFakeBackend) failList(prefix string, err error) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.listFailures[prefix] = err
}

func (backend *previewAdapterFakeBackend) clearListFailure(prefix string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	delete(backend.listFailures, prefix)
}

func (backend *previewAdapterFakeBackend) snapshotWrites() ([]string, []previewAdapterConditionalWrite) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return append([]string(nil), backend.putAttempts...), append([]previewAdapterConditionalWrite(nil), backend.conditionalWrites...)
}

func (backend *previewAdapterFakeBackend) snapshotDeleteCalls() [][]string {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	calls := make([][]string, len(backend.deleteCalls))
	for index := range backend.deleteCalls {
		calls[index] = append([]string(nil), backend.deleteCalls[index]...)
	}
	return calls
}

func TestObjectPreviewStoreDistinguishesMissingFromOriginFailures(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}

	key, err := preview.ManifestKey("sre", "0123456789abcdef0123456789abcdef01234567")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadObject(context.Background(), key); !errors.Is(err, preview.ErrObjectNotFound) {
		t.Fatalf("ReadObject(missing) error = %v, want preview.ErrObjectNotFound", err)
	}

	for _, test := range []struct {
		name string
		err  error
	}{
		{name: "authorization", err: errors.New("origin returned 403 access denied")},
		{name: "transport", err: errors.New("origin connection reset")},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend.failGet(mustProviderObjectKey(t, key), test.err)
			_, got := store.ReadObject(context.Background(), key)
			if !errors.Is(got, test.err) {
				t.Fatalf("ReadObject(%s) error = %v, want original failure %v", test.name, got, test.err)
			}
			if errors.Is(got, preview.ErrObjectNotFound) {
				t.Fatalf("ReadObject(%s) misclassified an origin failure as absence: %v", test.name, got)
			}
			backend.failGet(mustProviderObjectKey(t, key), nil)
		})
	}
}

func TestObjectPreviewStoreCreatesImmutableObjectsOnce(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	key, err := preview.FileKey("sre", "0123456789abcdef0123456789abcdef01234567", "docs/review.md")
	if err != nil {
		t.Fatal(err)
	}
	firstBytes := []byte("# Review\n")
	if err := store.CreateImmutableObject(context.Background(), key, firstBytes); err != nil {
		t.Fatalf("first CreateImmutableObject() error = %v", err)
	}
	_, originalETag, err := backend.lockMemoryBackend.GetObject(context.Background(), mustProviderObjectKey(t, key))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateImmutableObject(context.Background(), key, firstBytes); err != nil {
		t.Fatalf("same-byte CreateImmutableObject() retry error = %v", err)
	}
	if err := store.CreateImmutableObject(context.Background(), key, []byte("# Changed\n")); !errors.Is(err, preview.ErrImmutableObjectConflict) {
		t.Fatalf("changed-byte CreateImmutableObject() error = %v, want immutable conflict", err)
	}
	actual, actualETag, err := backend.lockMemoryBackend.GetObject(context.Background(), mustProviderObjectKey(t, key))
	if err != nil || actualETag != originalETag || !bytes.Equal(actual.Bytes, firstBytes) {
		t.Fatalf("immutable object after retries = %q, ETag %q, err=%v; want original bytes and ETag %q", actual.Bytes, actualETag, err, originalETag)
	}

	_, conditions := backend.snapshotWrites()
	var fileWrites []ObjectCondition
	for _, write := range conditions {
		if write.key == mustProviderObjectKey(t, key) {
			fileWrites = append(fileWrites, write.condition)
		}
	}
	if len(fileWrites) != 3 {
		t.Fatalf("immutable conditional-write attempts = %d, want initial write plus two retries", len(fileWrites))
	}
	for index, condition := range fileWrites {
		if !condition.IfNoneMatch || condition.IfMatchETag != "" {
			t.Errorf("immutable write %d condition = %+v, want If-None-Match only", index+1, condition)
		}
	}
}

func TestPreviewStoresPublishRawUTF8KeysAndServeNormallyEncodedURLs(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	documentPath := "guides/review résumé #%2F +?.html"
	resourcePath := "guides/assets/theme #%2F +? 日本.css"
	files := map[string][]byte{
		documentPath: []byte("<!doctype html><title>Encoded preview</title>\n"),
		resourcePath: []byte("body { color: rebeccapurple; }\n"),
	}
	documents := []preview.Document{{Path: documentPath, Title: "Encoded preview", Format: "html"}}
	result := previewAdapterBuildResultWithFiles(
		previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", headSHA),
		files, documents,
	)

	for _, adapter := range []struct {
		name                  string
		storagePrefix         string
		stripPreviewURLPrefix bool
		store                 func(string) (preview.PreviewStore, error)
	}{
		{
			name:                  "directory preview store",
			stripPreviewURLPrefix: true,
			store: func(root string) (preview.PreviewStore, error) {
				return preview.NewDirectoryStore(root)
			},
		},
		{
			name:          "object-backed configured local target",
			storagePrefix: "_previews",
			store: func(root string) (preview.PreviewStore, error) {
				backend, err := NewDirectoryBackend(root)
				if err != nil {
					return nil, err
				}
				return NewObjectPreviewStore(backend)
			},
		},
	} {
		t.Run(adapter.name, func(t *testing.T) {
			root := t.TempDir()
			store, err := adapter.store(root)
			if err != nil {
				t.Fatal(err)
			}
			if err := preview.Publish(context.Background(), store, result); err != nil {
				t.Fatalf("Publish() error = %v", err)
			}

			manifestKey, err := preview.ManifestKey("sre", headSHA)
			if err != nil {
				t.Fatal(err)
			}
			manifestBytes, err := store.ReadObject(context.Background(), manifestKey)
			if err != nil {
				t.Fatalf("ReadObject(manifest) error = %v", err)
			}
			manifest, err := preview.DecodeManifest(manifestBytes)
			if err != nil {
				t.Fatalf("DecodeManifest() error = %v", err)
			}
			if len(manifest.Documents) != 1 || manifest.Documents[0].Path != documentPath {
				t.Fatalf("published manifest documents = %+v, want raw source path %q", manifest.Documents, documentPath)
			}
			if len(manifest.Files) != len(files) {
				t.Fatalf("published manifest files = %+v, want %d source paths", manifest.Files, len(files))
			}
			manifestPaths := make(map[string]bool, len(manifest.Files))
			for _, file := range manifest.Files {
				manifestPaths[file.Path] = true
			}
			for sourcePath := range files {
				if !manifestPaths[sourcePath] {
					t.Errorf("published manifest omitted raw source path %q: %+v", sourcePath, manifest.Files)
				}
			}

			for sourcePath, want := range files {
				key, err := preview.FileKey("sre", headSHA, sourcePath)
				if err != nil {
					t.Fatalf("FileKey(%q) error = %v", sourcePath, err)
				}
				storageKey := "_previews/sre/revisions/" + headSHA + "/files/" + sourcePath
				if rawKey, rawErr := preview.RawObjectKey(key); rawErr != nil || rawKey != storageKey {
					t.Fatalf("RawObjectKey(%q) = %q, %v; want exactly-once decoded key %q", key, rawKey, rawErr, storageKey)
				}
				if sourcePath == documentPath {
					wantKey := "/_previews/sre/revisions/" + headSHA + "/files/guides/review%20r%C3%A9sum%C3%A9%20%23%252F%20%2B%3F.html"
					if key != wantKey {
						t.Fatalf("FileKey() = %q, want one-encoded-segment URL %q", key, wantKey)
					}
				}
				relativeStorageKey := storageKey
				if adapter.storagePrefix == "" {
					relativeStorageKey = strings.TrimPrefix(storageKey, "_previews/")
				}
				storedBytes, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relativeStorageKey)))
				if err != nil {
					t.Fatalf("read raw storage key %q: %v", storageKey, err)
				}
				if !bytes.Equal(storedBytes, want) {
					t.Errorf("raw storage key %q contains %q, want %q", storageKey, storedBytes, want)
				}

				var handler http.Handler = http.FileServer(http.Dir(root))
				if adapter.stripPreviewURLPrefix {
					handler = http.StripPrefix("/_previews/", handler)
				}
				server := httptest.NewServer(handler)
				response, err := http.Get(server.URL + key)
				if err != nil {
					server.Close()
					t.Fatalf("GET normally encoded URL %q: %v", key, err)
				}
				responseBytes, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				server.Close()
				if readErr != nil || closeErr != nil {
					t.Fatalf("read GET %q response: read=%v close=%v", key, readErr, closeErr)
				}
				if response.StatusCode != http.StatusOK || !bytes.Equal(responseBytes, want) {
					t.Errorf("GET %q = status %d body %q; want 200 and %q", key, response.StatusCode, responseBytes, want)
				}
			}

			route, err := preview.DocumentRouteHref("sre", headSHA, documentPath, "pr:42")
			if err != nil {
				t.Fatal(err)
			}
			wantRoute := "/sre/_previews/" + headSHA + "/guides/review%20r%C3%A9sum%C3%A9%20%23%252F%20%2B%3F.html?group=pr%3A42"
			if route != wantRoute {
				t.Errorf("DocumentRouteHref() = %q, want %q", route, wantRoute)
			}

			for _, invalidKey := range []string{
				"/_previews/sre/revisions/" + headSHA + "/files/%2E%2E/escape.html",
				"/_previews/sre/revisions/" + headSHA + "/files/guides%2Fescape.html",
			} {
				if _, err := preview.RawObjectKey(invalidKey); err == nil {
					t.Errorf("RawObjectKey(%q) accepted traversal or an encoded path separator", invalidKey)
				}
				if err := store.CreateImmutableObject(context.Background(), invalidKey, []byte("must not be written")); err == nil {
					t.Errorf("CreateImmutableObject(%q) accepted traversal or an encoded path separator", invalidKey)
				}
			}
		})
	}
}

func TestPreviewObjectMetadataUsesStableInlineContentAndCachePolicies(t *testing.T) {
	tests := []struct {
		key         string
		cache       string
		contentType string
	}{
		{key: "_previews/sre/catalog.json", cache: previewCatalogCache, contentType: "application/json; charset=utf-8"},
		{key: "_previews/sre/revisions/head/manifest.json", cache: previewImmutableCache, contentType: "application/json; charset=utf-8"},
		{key: "_previews/sre/revisions/head/files/report.html", cache: previewImmutableCache, contentType: "text/html; charset=utf-8"},
		{key: "_previews/sre/revisions/head/files/guide.md", cache: previewImmutableCache, contentType: "text/markdown; charset=utf-8"},
		{key: "_previews/sre/revisions/head/files/assets/site.css", cache: previewImmutableCache, contentType: "text/css; charset=utf-8"},
		{key: "_previews/sre/revisions/head/files/assets/site.js", cache: previewImmutableCache, contentType: "text/javascript; charset=utf-8"},
		{key: "_previews/sre/revisions/head/files/assets/icon.svg", cache: previewImmutableCache, contentType: "image/svg+xml; charset=utf-8"},
		{key: "_previews/sre/revisions/head/files/fonts/site.woff2", cache: previewImmutableCache, contentType: "font/woff2"},
		{key: "_previews/sre/revisions/head/files/data/unknown.bin", cache: previewImmutableCache, contentType: "application/octet-stream"},
	}
	for _, test := range tests {
		t.Run(test.key, func(t *testing.T) {
			object := previewObject(test.key, []byte("preview"), test.cache)
			if object.ContentType != test.contentType || object.ContentDisposition != "inline" || object.Cache != test.cache {
				t.Fatalf("preview metadata = type %q, disposition %q, cache %q; want %q, inline, %q", object.ContentType, object.ContentDisposition, object.Cache, test.contentType, test.cache)
			}
			if object.Metadata["artifact-pages-preview"] != "true" {
				t.Fatalf("preview marker metadata = %v, want artifact-pages-preview=true", object.Metadata)
			}
		})
	}
}

func TestObjectPreviewStoreRequiresLockContextForCatalogReplacement(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}

	err = store.ReplaceMutableObject(context.Background(), catalogKey, []byte(`{"schemaVersion":1,"site":"sre","groups":[]}`))
	if err == nil || !strings.Contains(err.Error(), `preview catalog for site "sre" requires an active site lock`) {
		t.Fatalf("ReplaceMutableObject() without a lock context error = %v, want a missing-lock rejection", err)
	}
	if _, _, err := backend.lockMemoryBackend.GetObject(context.Background(), mustProviderObjectKey(t, catalogKey)); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("catalog after rejected replacement = %v, want no catalog object", err)
	}
}

func TestObjectPreviewStorePublishRetriesMutableCatalogReplacement(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	result := previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", "0123456789abcdef0123456789abcdef01234567")
	catalogKey, _ := preview.CatalogKey("sre")
	backend.failNextPut(mustProviderObjectKey(t, catalogKey), errors.New("injected catalog replacement failure"))

	if err := preview.Publish(context.Background(), store, result); err == nil || !strings.Contains(err.Error(), "injected catalog replacement failure") {
		t.Fatalf("first Publish() error = %v, want injected catalog failure", err)
	}
	manifestKey, _ := preview.ManifestKey("sre", result.Manifest.HeadSHA)
	if _, err := store.ReadObject(context.Background(), manifestKey); err != nil {
		t.Fatalf("completed manifest after catalog failure = %v, want retained for retry", err)
	}
	if _, err := store.ReadObject(context.Background(), catalogKey); !errors.Is(err, preview.ErrObjectNotFound) {
		t.Fatalf("catalog after failed replacement error = %v, want confirmed absence", err)
	}

	_, writesBeforeRetry := backend.snapshotWrites()
	if err := preview.Publish(context.Background(), store, result); err != nil {
		t.Fatalf("retry Publish() error = %v", err)
	}
	catalogBytes, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatalf("catalog after retry = %v", err)
	}
	catalog, err := preview.DecodeCatalog(catalogBytes)
	if err != nil || len(catalog.Groups) != 1 || catalog.Groups[0].HeadSHA != result.Manifest.HeadSHA {
		t.Fatalf("catalog after retry = %+v, err=%v; want the completed group", catalog, err)
	}

	_, writesAfterRetry := backend.snapshotWrites()
	countCreates := func(writes []previewAdapterConditionalWrite) int {
		count := 0
		for _, write := range writes {
			if strings.HasPrefix(write.key, "_previews/sre/revisions/") && write.condition.IfNoneMatch {
				count++
			}
		}
		return count
	}
	if got, want := countCreates(writesAfterRetry), countCreates(writesBeforeRetry); got != want {
		t.Fatalf("immutable create attempts after catalog retry = %d, want unchanged count %d", got, want)
	}

	object, _, err := backend.lockMemoryBackend.GetObject(context.Background(), mustProviderObjectKey(t, catalogKey))
	if err != nil {
		t.Fatal(err)
	}
	if object.Cache != previewCatalogCache || object.ContentType != "application/json; charset=utf-8" {
		t.Fatalf("catalog metadata = cache %q, content type %q", object.Cache, object.ContentType)
	}
}

func TestObjectPreviewStoreConcurrentGroupsKeepBothCatalogAndIsolateOtherSites(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	otherSite := previewAdapterBuildResult("docs", "pr:9", "https://github.com/acme/docs/pull/9", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	if err := preview.Publish(context.Background(), store, otherSite); err != nil {
		t.Fatalf("initial docs Publish() error = %v", err)
	}
	otherSiteBefore := snapshotPreviewAdapterPrefix(t, backend, "_previews/docs/")
	otherSiteLockBefore, otherSiteLockETagBefore, err := backend.lockMemoryBackend.GetObject(context.Background(), siteLockKey("docs"))
	if err != nil {
		t.Fatalf("read docs lock before concurrent SRE publishes: %v", err)
	}

	first := previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", "0123456789abcdef0123456789abcdef01234567")
	second := previewAdapterBuildResult("sre", "pr:43", "https://github.com/acme/sre/pull/43", "2222222222222222222222222222222222222222")
	firstFileKey, err := preview.FileKey(first.Site, first.Manifest.HeadSHA, "docs/review.md")
	if err != nil {
		t.Fatal(err)
	}
	secondFileKey, err := preview.FileKey(second.Site, second.Manifest.HeadSHA, "docs/review.md")
	if err != nil {
		t.Fatal(err)
	}
	firstAtStorage := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondObservedHeldLock := make(chan struct{}, 1)
	var releaseOnce sync.Once
	releaseFirstPublish := func() { releaseOnce.Do(func() { close(releaseFirst) }) }
	backend.mu.Lock()
	backend.afterGet = func(key string, object Object, _ string, readErr error) {
		if key != siteLockKey("sre") || readErr != nil {
			return
		}
		var record lockRecord
		if json.Unmarshal(object.Bytes, &record) == nil && record.State == "held" {
			select {
			case secondObservedHeldLock <- struct{}{}:
			default:
			}
		}
	}
	backend.afterConditional = func(key string, _ ObjectCondition) {
		if key == providerObjectKey(firstFileKey) {
			close(firstAtStorage)
			<-releaseFirst
		}
	}
	backend.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	defer releaseFirstPublish()
	firstDone := make(chan error, 1)
	go func() { firstDone <- preview.Publish(ctx, store, first) }()
	select {
	case <-firstAtStorage:
	case <-ctx.Done():
		t.Fatalf("first publisher did not reach its immutable file write: %v", ctx.Err())
	}

	secondDone := make(chan error, 1)
	go func() { secondDone <- preview.Publish(ctx, store, second) }()
	select {
	case <-secondObservedHeldLock:
	case <-ctx.Done():
		t.Fatalf("second publisher did not observe the held same-site lock: %v", ctx.Err())
	}
	select {
	case err := <-secondDone:
		t.Fatalf("second publisher completed while the first held the site lock: %v", err)
	default:
	}
	if _, _, err := backend.lockMemoryBackend.GetObject(ctx, mustProviderObjectKey(t, secondFileKey)); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("second group's immutable file before lock release = %v, want no upload", err)
	}

	releaseFirstPublish()
	for name, done := range map[string]<-chan error{"first": firstDone, "second": secondDone} {
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("%s Publish() error = %v", name, err)
			}
		case <-ctx.Done():
			t.Errorf("%s publisher did not finish after lock release: %v", name, ctx.Err())
		}
	}

	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}
	catalogBytes, err := store.ReadObject(ctx, catalogKey)
	if err != nil {
		t.Fatalf("read SRE catalog after concurrent publishes: %v", err)
	}
	catalog, err := preview.DecodeCatalog(catalogBytes)
	if err != nil {
		t.Fatal(err)
	}
	gotGroups := make(map[string]string, len(catalog.Groups))
	for _, group := range catalog.Groups {
		gotGroups[group.ID] = group.HeadSHA
	}
	if len(gotGroups) != 2 || gotGroups[first.Group.ID] != first.Manifest.HeadSHA || gotGroups[second.Group.ID] != second.Manifest.HeadSHA {
		t.Fatalf("concurrent SRE catalog groups = %+v; want both groups %q and %q", catalog.Groups, first.Group.ID, second.Group.ID)
	}
	for _, result := range []preview.BuildResult{first, second} {
		manifestKey, err := preview.ManifestKey(result.Site, result.Manifest.HeadSHA)
		if err != nil {
			t.Fatal(err)
		}
		manifestBytes, err := store.ReadObject(ctx, manifestKey)
		if err != nil {
			t.Errorf("immutable manifest for %s = %v", result.Group.ID, err)
		} else {
			var manifest preview.RevisionManifest
			if err := json.Unmarshal(manifestBytes, &manifest); err != nil || manifest.Site != result.Site || manifest.HeadSHA != result.Manifest.HeadSHA {
				t.Errorf("immutable manifest for %s = %+v, err=%v", result.Group.ID, manifest, err)
			}
		}
		fileKey, err := preview.FileKey(result.Site, result.Manifest.HeadSHA, "docs/review.md")
		if err != nil {
			t.Fatal(err)
		}
		fileBytes, err := store.ReadObject(ctx, fileKey)
		if err != nil || !bytes.Equal(fileBytes, result.Files["docs/review.md"]) {
			t.Errorf("immutable file for %s = %q, err=%v; want %q", result.Group.ID, fileBytes, err, result.Files["docs/review.md"])
		}
	}

	otherSiteAfter := snapshotPreviewAdapterPrefix(t, backend, "_previews/docs/")
	if !reflect.DeepEqual(otherSiteAfter, otherSiteBefore) {
		t.Errorf("docs preview objects changed during concurrent SRE publishes: before=%v after=%v", objectKeysFromSnapshot(otherSiteBefore), objectKeysFromSnapshot(otherSiteAfter))
	}
	otherSiteLockAfter, otherSiteLockETagAfter, err := backend.lockMemoryBackend.GetObject(ctx, siteLockKey("docs"))
	if err != nil || !bytes.Equal(otherSiteLockAfter.Bytes, otherSiteLockBefore.Bytes) || otherSiteLockETagAfter != otherSiteLockETagBefore {
		t.Errorf("docs site lock changed during concurrent SRE publishes: beforeETag=%q afterETag=%q err=%v", otherSiteLockETagBefore, otherSiteLockETagAfter, err)
	}
}

func TestObjectPreviewStoreStopsCatalogWriteAfterLockLossAndCanRetry(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	result := previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", "0123456789abcdef0123456789abcdef01234567")
	catalogKey, _ := preview.CatalogKey("sre")
	manifestKey, _ := preview.ManifestKey("sre", result.Manifest.HeadSHA)
	lockKey := siteLockKey("sre")
	var lockWasReplaced bool
	var lockMutationErr error
	backend.mu.Lock()
	backend.afterConditional = func(key string, _ ObjectCondition) {
		if key != mustProviderObjectKey(t, manifestKey) || lockWasReplaced {
			return
		}
		lockObject, lockETag, getErr := backend.lockMemoryBackend.GetObject(context.Background(), lockKey)
		if getErr != nil {
			lockMutationErr = getErr
			return
		}
		var record lockRecord
		if unmarshalErr := json.Unmarshal(lockObject.Bytes, &record); unmarshalErr != nil {
			lockMutationErr = unmarshalErr
			return
		}
		// Simulate a guarded operator recovery changing the lock generation
		// after the immutable revision completed but before its catalog write.
		record.State, record.Owner, record.AcquiredAt = "free", "", time.Time{}
		freeBytes, marshalErr := json.Marshal(record)
		if marshalErr != nil {
			lockMutationErr = marshalErr
			return
		}
		if _, putErr := backend.lockMemoryBackend.PutObjectConditional(context.Background(), lockKey, Object{Bytes: freeBytes}, ObjectCondition{IfMatchETag: lockETag}); putErr != nil {
			lockMutationErr = putErr
			return
		}
		lockWasReplaced = true
	}
	backend.mu.Unlock()

	err = preview.Publish(context.Background(), store, result)
	if !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("Publish() after lock loss error = %v, want ErrPreconditionFailed", err)
	}
	if !lockWasReplaced {
		t.Fatalf("test did not replace the held site lock: %v", lockMutationErr)
	}
	if _, err := store.ReadObject(context.Background(), catalogKey); !errors.Is(err, preview.ErrObjectNotFound) {
		t.Fatalf("catalog after lock loss error = %v, want no catalog write", err)
	}
	if _, err := store.ReadObject(context.Background(), manifestKey); err != nil {
		t.Fatalf("completed manifest after lock loss = %v, want immutable object retained", err)
	}
	puts, _ := backend.snapshotWrites()
	for _, key := range puts {
		if key == mustProviderObjectKey(t, catalogKey) {
			t.Fatal("catalog replacement reached the backend after the site lock was lost")
		}
	}

	backend.mu.Lock()
	backend.afterConditional = nil
	backend.mu.Unlock()
	if err := preview.Publish(context.Background(), store, result); err != nil {
		t.Fatalf("Publish() retry after lock loss error = %v", err)
	}
	if _, err := store.ReadObject(context.Background(), catalogKey); err != nil {
		t.Fatalf("catalog after successful retry = %v", err)
	}
}

func TestObjectPreviewStoreSitePrefixesRemainIsolated(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	const headSRE = "0123456789abcdef0123456789abcdef01234567"
	const headDocs = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
	foreignFileKey, err := preview.FileKey("docs", headDocs, "docs/review.md")
	if err != nil {
		t.Fatal(err)
	}
	err = store.WithSiteLock(context.Background(), "sre", func(lockedContext context.Context) error {
		return store.CreateImmutableObject(lockedContext, foreignFileKey, []byte("wrong site"))
	})
	if err == nil || !strings.Contains(err.Error(), `cannot be written under "sre" site lock`) {
		t.Fatalf("cross-site immutable write error = %v, want site-lock scope error", err)
	}
	if _, err := store.ReadObject(context.Background(), foreignFileKey); !errors.Is(err, preview.ErrObjectNotFound) {
		t.Fatalf("cross-site immutable object after rejected write = %v, want absent", err)
	}
	for _, result := range []preview.BuildResult{
		previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", headSRE),
		previewAdapterBuildResult("docs", "pr:42", "https://github.com/acme/docs/pull/42", headDocs),
	} {
		if err := preview.Publish(context.Background(), store, result); err != nil {
			t.Fatalf("initial Publish(%s) error = %v", result.Site, err)
		}
	}

	otherSiteBefore := snapshotPreviewAdapterPrefix(t, backend, "_previews/docs/")
	otherLockBefore, otherLockETagBefore, err := backend.lockMemoryBackend.GetObject(context.Background(), siteLockKey("docs"))
	if err != nil {
		t.Fatalf("read docs lock before SRE update: %v", err)
	}
	putsBefore, conditionalBefore := backend.snapshotWrites()
	if err := preview.Publish(context.Background(), store, previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", "2222222222222222222222222222222222222222")); err != nil {
		t.Fatalf("second Publish(sre) error = %v", err)
	}

	otherSiteAfter := snapshotPreviewAdapterPrefix(t, backend, "_previews/docs/")
	if !reflect.DeepEqual(otherSiteAfter, otherSiteBefore) {
		t.Fatalf("docs preview objects changed during SRE publish: before=%v after=%v", objectKeysFromSnapshot(otherSiteBefore), objectKeysFromSnapshot(otherSiteAfter))
	}
	otherLockAfter, otherLockETagAfter, err := backend.lockMemoryBackend.GetObject(context.Background(), siteLockKey("docs"))
	if err != nil || !bytes.Equal(otherLockAfter.Bytes, otherLockBefore.Bytes) || otherLockETagAfter != otherLockETagBefore {
		t.Fatalf("docs site lock changed during SRE publish: beforeETag=%q afterETag=%q err=%v", otherLockETagBefore, otherLockETagAfter, err)
	}

	putsAfter, conditionalAfter := backend.snapshotWrites()
	for _, key := range putsAfter[len(putsBefore):] {
		if !strings.HasPrefix(key, "_previews/sre/") {
			t.Errorf("SRE publish wrote mutable object outside its prefix: %q", key)
		}
	}
	for _, write := range conditionalAfter[len(conditionalBefore):] {
		if write.key != siteLockKey("sre") && !strings.HasPrefix(write.key, "_previews/sre/") {
			t.Errorf("SRE publish conditionally wrote object outside its prefix: %q", write.key)
		}
	}
}

func TestObjectPreviewStoreDoesNotDeleteAfterPartialSiteListing(t *testing.T) {
	backend := newPreviewAdapterFakeBackend()
	registryBytes, _, err := testRegistryBuild(t, []byte(registeredSREAndDocsManifest))
	if err != nil {
		t.Fatal(err)
	}
	seedMemoryObject(backend.lockMemoryBackend, "_indexes/sites.json", registryBytes)
	for key, contents := range map[string][]byte{
		"_artifacts/sre/old.html":                        []byte("old SRE artifact"),
		"_indexes/sre/index.json":                        []byte(`{"site":"sre"}`),
		"_previews/sre/catalog.json":                     []byte(`{"site":"sre"}`),
		"_previews/sre/revisions/head/files/review.html": []byte("SRE preview"),
		"_artifacts/docs/neighbor.html":                  []byte("neighbor artifact"),
		"_indexes/docs/meta.json":                        []byte(`{"site":"docs"}`),
		"_previews/docs/catalog.json":                    []byte(`{"site":"docs"}`),
	} {
		seedMemoryObject(backend.lockMemoryBackend, key, contents)
	}
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	const previewPrefix = "_previews/sre/"
	partialListingErr := errors.New("second preview listing page unavailable")
	backend.failList(previewPrefix, partialListingErr)

	_, err = UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutSRE), "sre", false)
	if !errors.Is(err, partialListingErr) {
		t.Fatalf("UnregisterSite() error = %v, want partial listing failure", err)
	}
	if calls := backend.snapshotDeleteCalls(); len(calls) != 0 {
		t.Fatalf("DeleteObjects calls after partial listing = %v, want no deletes", calls)
	}
	for _, key := range []string{
		"_artifacts/sre/old.html", "_indexes/sre/index.json", "_previews/sre/catalog.json", "_previews/sre/revisions/head/files/review.html",
	} {
		if _, _, readErr := backend.lockMemoryBackend.GetObject(context.Background(), key); readErr != nil {
			t.Errorf("site object %q disappeared after partial listing: %v", key, readErr)
		}
	}

	backend.clearListFailure(previewPrefix)
	if _, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, manifestWithoutSRE), "sre", false); err != nil {
		t.Fatalf("UnregisterSite() retry error = %v", err)
	}
	if calls := backend.snapshotDeleteCalls(); len(calls) < 2 {
		t.Fatalf("DeleteObjects calls after successful retry = %v, want site cleanup and retry-record cleanup", calls)
	}
	for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", previewPrefix} {
		keys, listErr := backend.lockMemoryBackend.ListKeys(context.Background(), prefix)
		if listErr != nil || len(keys) != 0 {
			t.Errorf("keys after retry under %q = %v, err=%v; want empty", prefix, keys, listErr)
		}
	}
	for key, want := range map[string]string{
		"_artifacts/docs/neighbor.html": "neighbor artifact",
		"_indexes/docs/meta.json":       `{"site":"docs"}`,
		"_previews/docs/catalog.json":   `{"site":"docs"}`,
	} {
		object, _, readErr := backend.lockMemoryBackend.GetObject(context.Background(), key)
		if readErr != nil || string(object.Bytes) != want {
			t.Errorf("neighbor object %q = %q, err=%v; want %q", key, object.Bytes, readErr, want)
		}
	}
	neighborCatalogKey, _ := preview.CatalogKey("docs")
	if _, err := store.ReadObject(context.Background(), neighborCatalogKey); err != nil {
		t.Fatalf("neighbor preview through shared adapter after unregister retry = %v", err)
	}
}

type previewAdapterObjectSnapshot struct {
	object Object
	etag   string
}

func snapshotPreviewAdapterPrefix(t *testing.T, backend *previewAdapterFakeBackend, prefix string) map[string]previewAdapterObjectSnapshot {
	t.Helper()
	keys, err := backend.lockMemoryBackend.ListKeys(context.Background(), prefix)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := make(map[string]previewAdapterObjectSnapshot, len(keys))
	for _, key := range keys {
		object, etag, err := backend.lockMemoryBackend.GetObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		snapshot[key] = previewAdapterObjectSnapshot{object: object, etag: etag}
	}
	return snapshot
}

func objectKeysFromSnapshot(snapshot map[string]previewAdapterObjectSnapshot) []string {
	keys := make([]string, 0, len(snapshot))
	for key := range snapshot {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func mustProviderObjectKey(t *testing.T, key string) string {
	t.Helper()
	return providerObjectKey(key)
}

func providerObjectKey(key string) string {
	objectKey, err := preview.RawObjectKey(key)
	if err != nil {
		panic(err)
	}
	return objectKey
}

func previewAdapterBuildResult(site, groupID, prURL, headSHA string) preview.BuildResult {
	files := map[string][]byte{"docs/review.md": []byte("# Review\n")}
	documents := []preview.Document{{Path: "docs/review.md", Title: "Review", Format: "markdown"}}
	fileDigest := sha256.Sum256(files["docs/review.md"])
	contentDigest := previewAdapterBundleDigest(files)
	group := preview.Group{
		ID: groupID, Kind: "pull-request", HeadSHA: headSHA, PRURL: prURL,
		UpdatedAt: "2026-09-27T00:00:00Z", Documents: documents,
	}
	manifest := preview.RevisionManifest{
		SchemaVersion: preview.SchemaVersion, Site: site, HeadSHA: headSHA,
		DefaultHead: "1111111111111111111111111111111111111111",
		MergeBase:   "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
		CreatedAt:   "2026-09-27T00:00:00Z", BundleDigest: contentDigest,
		Files:     []preview.PreviewFile{{Path: "docs/review.md", SHA256: hex.EncodeToString(fileDigest[:]), ContentType: "text/markdown; charset=utf-8"}},
		Documents: documents,
	}
	return preview.BuildResult{Site: site, Outcome: preview.OutcomePublished, Group: group, Manifest: manifest, Files: files}
}

func previewAdapterBuildResultWithFiles(result preview.BuildResult, files map[string][]byte, documents []preview.Document) preview.BuildResult {
	result.Files = files
	result.Group.Documents = append([]preview.Document(nil), documents...)
	result.Manifest.Documents = append([]preview.Document(nil), documents...)
	result.Manifest.Files = make([]preview.PreviewFile, 0, len(files))
	for _, sourcePath := range sortedPreviewAdapterFilePaths(files) {
		digest := sha256.Sum256(files[sourcePath])
		result.Manifest.Files = append(result.Manifest.Files, preview.PreviewFile{
			Path: sourcePath, SHA256: hex.EncodeToString(digest[:]), ContentType: contentType(sourcePath),
		})
	}
	result.Manifest.BundleDigest = previewAdapterBundleDigest(files)
	return result
}

func sortedPreviewAdapterFilePaths(files map[string][]byte) []string {
	paths := make([]string, 0, len(files))
	for sourcePath := range files {
		paths = append(paths, sourcePath)
	}
	sort.Strings(paths)
	return paths
}

func previewAdapterBundleDigest(files map[string][]byte) string {
	paths := make([]string, 0, len(files))
	for filePath := range files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	hasher := sha256.New()
	for _, filePath := range paths {
		content := files[filePath]
		var length [8]byte
		binary.BigEndian.PutUint64(length[:], uint64(len(filePath)))
		_, _ = hasher.Write(length[:])
		_, _ = hasher.Write([]byte(filePath))
		binary.BigEndian.PutUint64(length[:], uint64(len(content)))
		_, _ = hasher.Write(length[:])
		_, _ = hasher.Write(content)
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

var _ ConditionalObjectBackend = (*previewAdapterFakeBackend)(nil)
var _ preview.PreviewStore = (*ObjectPreviewStore)(nil)
