package publisher

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type appRemoveFaultBackend struct {
	*appCachePublishBackend
	validationErr error
}

func (backend *appRemoveFaultBackend) ValidateInvalidation(paths []string) error {
	if backend.validationErr != nil {
		return backend.validationErr
	}
	return nil
}

func seedAppRemoveObjects(t *testing.T, backend *appCachePublishBackend, keys ...string) {
	t.Helper()
	for _, key := range keys {
		if err := backend.store.objects.PutObject(context.Background(), key, Object{Bytes: []byte("owned object: " + key)}); err != nil {
			t.Fatalf("seed %s: %v", key, err)
		}
	}
}

func TestRemoveAppDryRunPlansOnlyApplicationObjectsWithoutWrites(t *testing.T) {
	backend := newAppCachePublishBackend()
	seedAppRemoveObjects(t, backend,
		"index.html", "preview-bridge.js", "LICENSE", "THIRD_PARTY_NOTICES.txt", "assets/app.js",
		"unowned.txt", "_artifacts/sre/report.html", "_indexes/sites.json", "_previews/sre/catalog.json",
	)

	result, err := RemoveApp(context.Background(), backend, AppRemoveOptions{DryRun: true})
	if err != nil {
		t.Fatalf("RemoveApp(dry-run) error = %v", err)
	}
	wantKeys := []string{"LICENSE", "THIRD_PARTY_NOTICES.txt", "assets/app.js", "index.html", "preview-bridge.js"}
	if result.Outcome != "planned" || result.FilesRemoved != len(wantKeys) || len(result.InvalidationPaths) != 0 || result.InvalidationID != "" {
		t.Fatalf("dry-run result = %+v; want exact application plan", result)
	}
	var planned []string
	for _, change := range result.Changes {
		planned = append(planned, change.Path)
	}
	if !reflect.DeepEqual(planned, wantKeys) {
		t.Fatalf("dry-run keys = %v; want %v", planned, wantKeys)
	}
	if len(backend.store.conditional) != 0 || len(backend.store.deletions) != 0 || len(backend.store.invalidations) != 0 {
		t.Fatalf("dry-run caused writes: conditional=%v deletes=%v invalidations=%v", backend.store.conditional, backend.store.deletions, backend.store.invalidations)
	}
	if len(backend.store.headWithoutHeldLock) != len(applicationRootObjects) {
		t.Fatalf("dry-run lock probes = %v; want only individual app-root HEAD checks without acquiring a lock", backend.store.headWithoutHeldLock)
	}
}

func TestRemoveAppUsesExactApplicationScopeWithoutPurgeJournal(t *testing.T) {
	backend := newAppCachePublishBackend()
	seedAppRemoveObjects(t, backend,
		"index.html", "preview-bridge.js", "LICENSE", "THIRD_PARTY_NOTICES.txt", "assets/app.js",
		"unowned.txt", "_artifacts/sre/report.html", "_indexes/sites.json", "_previews/sre/catalog.json",
	)

	result, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
	if err != nil {
		t.Fatalf("RemoveApp() error = %v", err)
	}
	if result.Outcome != "removed" || result.FilesRemoved != 5 || result.InvalidationID != "" || len(result.InvalidationPaths) != 0 {
		t.Fatalf("RemoveApp() = %+v; want five app objects removed without invalidation output", result)
	}
	for _, key := range []string{"index.html", "preview-bridge.js", "LICENSE", "THIRD_PARTY_NOTICES.txt", "assets/app.js"} {
		if _, _, err := backend.store.objects.GetObject(context.Background(), key); !errors.Is(err, ErrObjectNotFound) {
			t.Errorf("application object %q remains: %v", key, err)
		}
	}
	for _, key := range []string{"unowned.txt", "_artifacts/sre/report.html", "_indexes/sites.json", "_previews/sre/catalog.json"} {
		if _, _, err := backend.store.objects.GetObject(context.Background(), key); err != nil {
			t.Errorf("unrelated object %q was removed: %v", key, err)
		}
	}
	if len(backend.store.invalidations) != 0 {
		t.Fatalf("app removal made invalidation calls: %v", backend.store.invalidations)
	}
	assertAppCacheRetryPresent(t, backend.store, false)
}

func TestRemoveAppIgnoresPurgeValidationFailure(t *testing.T) {
	for _, test := range []struct {
		name    string
		fault   func(*appRemoveFaultBackend)
		wantErr string
	}{
		{name: "purge validation failure is irrelevant", fault: func(backend *appRemoveFaultBackend) { backend.validationErr = errors.New("invalidation rejected") }, wantErr: ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			base := newAppCachePublishBackend()
			seedAppRemoveObjects(t, base, "index.html", "assets/app.js")
			backend := &appRemoveFaultBackend{appCachePublishBackend: base}
			test.fault(backend)
			result, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
			if test.wantErr == "" {
				if err != nil {
					t.Fatalf("RemoveApp() error = %v; purge validation must not affect removal", err)
				}
				if len(base.store.invalidations) != 0 {
					t.Fatalf("invalidation calls = %v", base.store.invalidations)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("RemoveApp() error = %v; want %q", err, test.wantErr)
			}
			if result.FilesRemoved != 2 || len(base.store.invalidations) != 0 {
				t.Fatalf("origin removal result = %+v, invalidations=%v", result, base.store.invalidations)
			}
		})
	}
}

func TestAppRemovalIgnoresPurgeFailure(t *testing.T) {
	base := newAppCachePublishBackend()
	seedAppRemoveObjects(t, base, "index.html", "assets/app.js")
	base.failInvalidation = true
	removed, err := RemoveApp(context.Background(), base, AppRemoveOptions{})
	if err != nil || removed.FilesRemoved != 2 {
		t.Fatalf("RemoveApp() = %+v, %v; purge failure must not fail origin removal", removed, err)
	}
	assertAppCacheRetryPresent(t, base.store, false)
	if len(base.store.invalidations) != 0 {
		t.Fatalf("invalidation calls = %v", base.store.invalidations)
	}
}

func TestRemoveAppRetiresOnlyValidatedLegacyPurgeJournal(t *testing.T) {
	backend := newAppCachePublishBackend()
	seedAppRemoveObjects(t, backend, "index.html")
	if err := backend.store.objects.PutObject(context.Background(), appCacheRetryObjectKey, Object{Bytes: []byte(`{"schemaVersion":1,"paths":["/index.html"]}`), Cache: "no-store"}); err != nil {
		t.Fatal(err)
	}
	dry, err := RemoveApp(context.Background(), backend, AppRemoveOptions{DryRun: true})
	if err != nil || dry.Outcome != "planned" {
		t.Fatalf("dry-run = %+v, %v", dry, err)
	}
	assertAppCacheRetryPresent(t, backend.store, true)
	result, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
	if err != nil || result.Outcome != "removed" {
		t.Fatalf("RemoveApp() = %+v, %v", result, err)
	}
	assertAppCacheRetryPresent(t, backend.store, false)
	if len(backend.store.invalidations) != 0 {
		t.Fatalf("invalidation calls = %v", backend.store.invalidations)
	}
}

func TestRemoveAppRetriesPartialDeleteAndAmbiguousJournalClear(t *testing.T) {
	for _, test := range []struct {
		name  string
		fault func(*appCachePublishBackend)
	}{
		{name: "partial delete", fault: func(backend *appCachePublishBackend) { backend.partialDeleteOnce = true }},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newAppCachePublishBackend()
			seedAppRemoveObjects(t, backend, "index.html", "assets/app.js", "LICENSE")
			test.fault(backend)
			first, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
			if err == nil {
				t.Fatalf("first RemoveApp() = %+v; want injected failure", first)
			}
			if test.name == "partial delete" && first.FilesRemoved != 0 {
				t.Fatalf("partial delete failure reported filesRemoved=%d; want conservative zero", first.FilesRemoved)
			}
			second, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
			if err != nil || second.Outcome != "removed" {
				t.Fatalf("retry RemoveApp() = %+v, %v; want convergence", second, err)
			}
			for _, key := range []string{"index.html", "assets/app.js", "LICENSE"} {
				if _, _, err := backend.store.objects.GetObject(context.Background(), key); !errors.Is(err, ErrObjectNotFound) {
					t.Errorf("application object %q remains after retry: %v", key, err)
				}
			}
			assertAppCacheRetryPresent(t, backend.store, false)
		})
	}
}
