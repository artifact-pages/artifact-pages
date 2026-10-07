package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

type appCachePublishStore struct {
	objects *lockMemoryBackend

	getKeys       []string
	headKeys      []string
	events        []string
	appPuts       []string
	conditional   []string
	invalidations [][]string
	deletions     [][]string

	headWithoutHeldLock []string
}

type appCachePublishBackend struct {
	store *appCachePublishStore

	failInvalidation         bool
	failClearAfterDelete     bool
	failClearBeforeDelete    bool
	partialDeleteOnce        bool
	persistJournalThenError  bool
	failAppPutKey            string
	persistAppPutThenError   bool
	emptyApplicationLockETag bool
}

func newAppCachePublishBackend() *appCachePublishBackend {
	return newAppCachePublishWrapper(&appCachePublishStore{objects: newLockMemoryBackend()})
}

func newAppCachePublishWrapper(store *appCachePublishStore) *appCachePublishBackend {
	return &appCachePublishBackend{store: store}
}

func (backend *appCachePublishBackend) PutObject(ctx context.Context, key string, object Object) error {
	if !strings.HasPrefix(key, "_control/") {
		backend.store.appPuts = append(backend.store.appPuts, key)
	}
	backend.store.events = append(backend.store.events, "put:"+key)
	if key == backend.failAppPutKey {
		backend.failAppPutKey = ""
		if backend.persistAppPutThenError {
			if err := backend.store.objects.PutObject(ctx, key, object); err != nil {
				return err
			}
			backend.persistAppPutThenError = false
		}
		return errors.New("injected application-object PUT failure")
	}
	return backend.store.objects.PutObject(ctx, key, object)
}

func (backend *appCachePublishBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	return backend.store.objects.ListKeys(ctx, prefix)
}

func (backend *appCachePublishBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	backend.store.getKeys = append(backend.store.getKeys, key)
	backend.store.events = append(backend.store.events, "get:"+key)
	return backend.store.objects.GetObject(ctx, key)
}

func (backend *appCachePublishBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	backend.store.headKeys = append(backend.store.headKeys, key)
	backend.store.events = append(backend.store.events, "head:"+key)
	if !backend.store.hasHeldLock() {
		backend.store.headWithoutHeldLock = append(backend.store.headWithoutHeldLock, key)
	}
	return backend.store.objects.HeadObject(ctx, key)
}

func (backend *appCachePublishBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.store.conditional = append(backend.store.conditional, key)
	backend.store.events = append(backend.store.events, "conditional-put:"+key)
	etag, err := backend.store.objects.PutObjectConditional(ctx, key, object, condition)
	if err != nil {
		return etag, err
	}
	var lock lockRecord
	_ = json.Unmarshal(object.Bytes, &lock)
	if key == "_control/locks/application.json" && lock.State == "held" && backend.emptyApplicationLockETag {
		backend.emptyApplicationLockETag = false
		return "", nil
	}
	if key == appCacheRetryObjectKey && backend.persistJournalThenError {
		backend.persistJournalThenError = false
		return "", errors.New("injected response loss after retry journal persisted")
	}
	return etag, nil
}

func (backend *appCachePublishBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.store.deletions = append(backend.store.deletions, append([]string(nil), keys...))
	backend.store.events = append(backend.store.events, "delete:"+strings.Join(keys, ","))
	if backend.failClearBeforeDelete && len(keys) == 1 && keys[0] == appCacheRetryObjectKey {
		backend.failClearBeforeDelete = false
		return errors.New("injected retry journal deletion failure before persistence")
	}
	if backend.partialDeleteOnce && !(len(keys) == 1 && keys[0] == appCacheRetryObjectKey) {
		backend.partialDeleteOnce = false
		if len(keys) > 0 {
			if err := backend.store.objects.DeleteObjects(ctx, keys[:1]); err != nil {
				return err
			}
		}
		return errors.New("injected partial application delete")
	}
	if err := backend.store.objects.DeleteObjects(ctx, keys); err != nil {
		return err
	}
	if backend.failClearAfterDelete && len(keys) == 1 && keys[0] == appCacheRetryObjectKey {
		backend.failClearAfterDelete = false
		return errors.New("injected response loss after retry journal deletion")
	}
	return nil
}

func (backend *appCachePublishBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	backend.store.invalidations = append(backend.store.invalidations, append([]string(nil), paths...))
	backend.store.events = append(backend.store.events, "invalidate:"+strings.Join(paths, ","))
	if backend.failInvalidation {
		return "", errors.New("injected invalidation failure")
	}
	return backend.store.objects.Invalidate(ctx, paths)
}

func (backend *appCachePublishBackend) ValidateInvalidation([]string) error { return nil }

func (store *appCachePublishStore) hasHeldLock() bool {
	store.objects.mu.Lock()
	defer store.objects.mu.Unlock()
	for key, object := range store.objects.objects {
		if !strings.HasPrefix(key, "_control/locks/") {
			continue
		}
		var record lockRecord
		if json.Unmarshal(object.Bytes, &record) == nil && record.State == "held" {
			return true
		}
	}
	return false
}

func seedAppCacheRetryJournal(t *testing.T, store *appCachePublishStore, data []byte) {
	t.Helper()
	if _, err := store.objects.PutObjectConditional(context.Background(), appCacheRetryObjectKey, Object{
		Bytes: data, ContentType: "application/json; charset=utf-8", Cache: "no-store",
	}, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatalf("seed app cache retry journal: %v", err)
	}
}

func seedAppBundleObjects(t *testing.T, store *appCachePublishStore, archivePath string) {
	t.Helper()
	bundle, err := loadAppBundle(archivePath)
	if err != nil {
		t.Fatalf("load app bundle: %v", err)
	}
	for _, file := range bundle.files {
		if err := store.objects.PutObject(context.Background(), file.path, Object{
			Bytes: file.data, ContentType: contentType(file.path), Cache: appFileCacheControl(file.path), Metadata: map[string]string{
				"artifact-pages-version":       bundle.manifest.Version,
				"artifact-pages-source-commit": bundle.manifest.SourceCommit,
				"artifact-pages-sha256":        sha256Hex(file.data),
			},
		}); err != nil {
			t.Fatalf("seed app object %s: %v", file.path, err)
		}
	}
}

func assertAppCacheRetryPresent(t *testing.T, store *appCachePublishStore, want bool) {
	t.Helper()
	_, _, err := store.objects.GetObject(context.Background(), appCacheRetryObjectKey)
	present := err == nil
	if errors.Is(err, ErrObjectNotFound) {
		present = false
	} else if err != nil {
		t.Fatalf("read app retry journal: %v", err)
	}
	if present != want {
		t.Fatalf("app retry journal present = %t, want %t", present, want)
	}
}

func TestDeployAppRetriesPendingInvalidationWithoutRepublishing(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	first := newAppCachePublishBackend()
	first.failInvalidation = true
	firstResult, firstErr := DeployApp(context.Background(), first, AppDeployOptions{ArchivePath: archive})
	if firstErr == nil || firstResult.FilesPublished != 0 {
		t.Fatalf("first DeployApp() = %+v, %v; want retryable invalidation failure after origin writes", firstResult, firstErr)
	}
	if len(first.store.appPuts) != 2 {
		t.Fatalf("first application object PUTs = %v; want both bundle objects published", first.store.appPuts)
	}
	assertAppCacheRetryPresent(t, first.store, true)

	// A fresh backend wrapper models a new CLI process using the same origin.
	second := newAppCachePublishWrapper(first.store)
	second.store.appPuts = nil
	second.store.invalidations = nil
	second.store.deletions = nil
	result, err := DeployApp(context.Background(), second, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("retry DeployApp() error = %v", err)
	}
	if result.Outcome != "deployed" || result.FilesPublished != 0 || result.InvalidationID == "" || strings.Join(result.InvalidationPaths, ",") != "/index.html" {
		t.Fatalf("retry DeployApp() = %+v; want cache-only deployed result for /index.html", result)
	}
	if len(second.store.appPuts) != 0 {
		t.Fatalf("cache-only retry made application object PUTs: %v", second.store.appPuts)
	}
	if len(second.store.invalidations) != 1 || strings.Join(second.store.invalidations[0], ",") != "/index.html" {
		t.Fatalf("retry invalidations = %v; want only /index.html", second.store.invalidations)
	}
	assertAppCacheRetryPresent(t, second.store, false)
}

func TestDeployAppStopsWhenRetryJournalWriteMayHavePersisted(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	backend := newAppCachePublishBackend()
	backend.persistJournalThenError = true
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err == nil {
		t.Fatalf("DeployApp() = %+v, nil; want a journal write response failure", result)
	}
	if len(backend.store.appPuts) != 0 {
		t.Fatalf("application object PUTs before journal write was confirmed: %v", backend.store.appPuts)
	}
	if len(backend.store.invalidations) != 0 {
		t.Fatalf("invalidations after journal write failure = %v; want none", backend.store.invalidations)
	}
	assertAppCacheRetryPresent(t, backend.store, true)
}

func TestDeployAppRestoresRetryJournalAfterAmbiguousClearFailure(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	backend := newAppCachePublishBackend()
	backend.failClearAfterDelete = true
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err == nil {
		t.Fatalf("DeployApp() = %+v, nil; want ambiguous journal clear failure", result)
	}
	if len(backend.store.appPuts) != 2 || len(backend.store.invalidations) != 1 {
		t.Fatalf("app PUTs = %v, invalidations = %v; want a completed projection and purge", backend.store.appPuts, backend.store.invalidations)
	}
	assertAppCacheRetryPresent(t, backend.store, true)
}

func TestDeployAppRetriesPartialObjectWriteWithChangedSource(t *testing.T) {
	for _, persistBeforeError := range []bool{false, true} {
		name := "before persistence"
		if persistBeforeError {
			name = "after persistence"
		}
		t.Run(name, func(t *testing.T) {
			firstArchive := createWebBundle(t, map[string][]byte{
				"index.html":    []byte("shell first"),
				"assets/app.js": []byte("asset first"),
			})
			secondArchive := createWebBundle(t, map[string][]byte{
				"index.html":    []byte("shell second"),
				"assets/app.js": []byte("asset second"),
			})
			first := newAppCachePublishBackend()
			first.failAppPutKey = "index.html"
			first.persistAppPutThenError = persistBeforeError
			result, err := DeployApp(context.Background(), first, AppDeployOptions{ArchivePath: firstArchive})
			if err == nil || !strings.Contains(err.Error(), "publish application object index.html") {
				t.Fatalf("first DeployApp() = %+v, %v; want injected partial object write error", result, err)
			}
			if len(first.store.appPuts) != 2 || len(first.store.invalidations) != 0 {
				t.Fatalf("first PUTs = %v, invalidations = %v; want asset and failed index attempt without purge", first.store.appPuts, first.store.invalidations)
			}
			assertAppCacheRetryPresent(t, first.store, true)

			// Reopen the persisted store as a new process and change the desired
			// bundle before retrying. HEAD reconciliation must complete this latest
			// desired version while the prior invalidation intent remains durable.
			second := newAppCachePublishWrapper(first.store)
			second.store.appPuts = nil
			second.store.invalidations = nil
			retried, err := DeployApp(context.Background(), second, AppDeployOptions{ArchivePath: secondArchive})
			if err != nil {
				t.Fatalf("changed-source retry DeployApp() error = %v", err)
			}
			if retried.Outcome != "deployed" || retried.FilesPublished != 2 || len(second.store.appPuts) != 2 || second.store.appPuts[1] != "index.html" {
				t.Fatalf("changed-source retry = %+v, PUTs=%v; want both current objects and index last", retried, second.store.appPuts)
			}
			for key, want := range map[string]string{"index.html": "shell second", "assets/app.js": "asset second"} {
				object, _, err := second.store.objects.GetObject(context.Background(), key)
				if err != nil || string(object.Bytes) != want {
					t.Errorf("current object %q = %q, %v; want %q", key, object.Bytes, err, want)
				}
			}
			assertAppCacheRetryPresent(t, second.store, false)
		})
	}
}

func TestDeployAppRetriesJournalClearFailureBeforeDeletion(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("shell"),
		"assets/app.js": []byte("asset"),
	})
	first := newAppCachePublishBackend()
	first.failClearBeforeDelete = true
	if _, err := DeployApp(context.Background(), first, AppDeployOptions{ArchivePath: archive}); err == nil {
		t.Fatal("DeployApp() succeeded despite injected retry-journal delete failure")
	}
	assertAppCacheRetryPresent(t, first.store, true)

	second := newAppCachePublishWrapper(first.store)
	second.store.appPuts = nil
	second.store.invalidations = nil
	result, err := DeployApp(context.Background(), second, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("cache-only retry after clear failure: %v", err)
	}
	if result.Outcome != "deployed" || result.FilesPublished != 0 || len(second.store.appPuts) != 0 {
		t.Fatalf("cache-only retry = %+v, app PUTs=%v; want purge-only completion", result, second.store.appPuts)
	}
	if len(second.store.invalidations) != 1 {
		t.Fatalf("retry invalidations = %v; want one repeated cache request", second.store.invalidations)
	}
	assertAppCacheRetryPresent(t, second.store, false)
}

func TestDeployAppPendingDryRunReportsInvalidationWithoutMutationOrLock(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	backend := newAppCachePublishBackend()
	seedAppBundleObjects(t, backend.store, archive)
	seedAppCacheRetryJournal(t, backend.store, []byte(`{"schemaVersion":1,"paths":["/index.html"]}`))
	backend.store.getKeys = nil
	backend.store.headKeys = nil
	backend.store.events = nil
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive, DryRun: true})
	if err != nil {
		t.Fatalf("dry-run DeployApp() error = %v", err)
	}
	if result.Outcome != "planned" || result.FilesPublished != 0 || len(result.Changes) != 0 || strings.Join(result.InvalidationPaths, ",") != "/index.html" {
		t.Fatalf("dry-run DeployApp() = %+v; want a cache-only plan for /index.html", result)
	}
	if len(backend.store.appPuts) != 0 || len(backend.store.conditional) != 0 || len(backend.store.invalidations) != 0 || len(backend.store.deletions) != 0 {
		t.Fatalf("dry-run mutated origin: appPuts=%v conditional=%v invalidations=%v deletions=%v", backend.store.appPuts, backend.store.conditional, backend.store.invalidations, backend.store.deletions)
	}
	for _, key := range backend.store.getKeys {
		if strings.HasPrefix(key, "_control/locks/") {
			t.Fatalf("dry-run read application lock %q", key)
		}
	}
	for _, key := range backend.store.headKeys {
		if strings.HasPrefix(key, "_control/locks/") {
			t.Fatalf("dry-run inspected application lock %q", key)
		}
	}
	for _, event := range backend.store.events {
		if strings.Contains(event, "_control/locks/") || strings.HasPrefix(event, "put:") {
			t.Fatalf("dry-run performed lock or object write activity: %v", backend.store.events)
		}
	}
	assertAppCacheRetryPresent(t, backend.store, true)
}

func TestDeployAppRejectsMalformedRetryJournalBeforePublishing(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	backend := newAppCachePublishBackend()
	seedAppCacheRetryJournal(t, backend.store, []byte(`{"schemaVersion":1,"paths":["/_artifacts/other/file.html"]}`))
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err == nil {
		t.Fatalf("DeployApp() = %+v, nil; want malformed retry journal error", result)
	}
	if len(backend.store.headKeys) != 0 || len(backend.store.appPuts) != 0 || len(backend.store.invalidations) != 0 {
		t.Fatalf("malformed retry journal allowed work: HEADs=%v appPuts=%v invalidations=%v", backend.store.headKeys, backend.store.appPuts, backend.store.invalidations)
	}
	assertAppCacheRetryPresent(t, backend.store, true)
}

func TestDeployAppReadsRetryBeforeHeadAndChecksEveryHeadUnderLock(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	backend := newAppCachePublishBackend()
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("DeployApp() error = %v", err)
	}
	if result.Outcome != "deployed" || len(backend.store.headKeys) != 2 {
		t.Fatalf("DeployApp() = %+v, HEADs = %v; want deployment after inspecting both bundle objects", result, backend.store.headKeys)
	}
	firstHead, retryRead, journalWrite, firstAppPut := -1, -1, -1, -1
	for index, event := range backend.store.events {
		if event == "get:"+appCacheRetryObjectKey && retryRead == -1 {
			retryRead = index
		}
		if strings.HasPrefix(event, "head:") && firstHead == -1 {
			firstHead = index
		}
		if event == "conditional-put:"+appCacheRetryObjectKey && journalWrite == -1 {
			journalWrite = index
		}
		if strings.HasPrefix(event, "put:") && !strings.HasPrefix(event, "put:_control/") && firstAppPut == -1 {
			firstAppPut = index
		}
	}
	if retryRead == -1 || firstHead == -1 || retryRead >= firstHead {
		t.Fatalf("events = %v; want retry journal read before first HEAD", backend.store.events)
	}
	if journalWrite == -1 || firstAppPut == -1 || journalWrite >= firstAppPut {
		t.Fatalf("events = %v; want retry journal persisted before application PUTs", backend.store.events)
	}
	if got := backend.store.appPuts; len(got) != 2 || got[len(got)-1] != "index.html" {
		t.Fatalf("application PUT order = %v; want index.html last", got)
	}
	if len(backend.store.headWithoutHeldLock) != 0 {
		t.Fatalf("bundle HEADs outside application lock: %v", backend.store.headWithoutHeldLock)
	}
}

func TestDeployAppStopsBeforeReadsWhenLockAcquireResponseHasNoETag(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("shell"),
		"assets/app.js": []byte("asset"),
	})
	backend := newAppCachePublishBackend()
	backend.emptyApplicationLockETag = true
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err == nil || !strings.Contains(err.Error(), "conditional write returned no ETag") {
		t.Fatalf("DeployApp() = %+v, %v; want fail-closed lock CAS ETag error", result, err)
	}
	if len(backend.store.headKeys) != 0 || len(backend.store.appPuts) != 0 || len(backend.store.invalidations) != 0 {
		t.Fatalf("deployment proceeded without a releasable lock token: HEADs=%v appPuts=%v invalidations=%v", backend.store.headKeys, backend.store.appPuts, backend.store.invalidations)
	}
	manager := SiteLockManager{Backend: backend}
	lock, err := manager.InspectApplication(context.Background())
	if err != nil || lock.State != "held" || lock.ETag == "" {
		t.Fatalf("application lock after ambiguous acquisition = %+v, %v; want inspectable held lock", lock, err)
	}
	if err := manager.RecoverApplication(context.Background(), lock.ETag); err != nil {
		t.Fatalf("recover held lock after no-ETag response: %v", err)
	}
}
