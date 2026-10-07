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
	failRetryWrite bool
	validationErr  error
}

func (backend *appRemoveFaultBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	if key == appCacheRetryObjectKey && backend.failRetryWrite {
		backend.failRetryWrite = false
		return "", errors.New("injected app retry journal CAS failure")
	}
	return backend.appCachePublishBackend.PutObjectConditional(ctx, key, object, condition)
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
	if result.Outcome != "planned" || result.FilesRemoved != len(wantKeys) || !reflect.DeepEqual(result.InvalidationPaths, applicationRemovalInvalidationPaths) {
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

func TestRemoveAppUsesExactScopeAndApplicationCacheJournal(t *testing.T) {
	backend := newAppCachePublishBackend()
	seedAppRemoveObjects(t, backend,
		"index.html", "preview-bridge.js", "LICENSE", "THIRD_PARTY_NOTICES.txt", "assets/app.js",
		"unowned.txt", "_artifacts/sre/report.html", "_indexes/sites.json", "_previews/sre/catalog.json",
	)

	result, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
	if err != nil {
		t.Fatalf("RemoveApp() error = %v", err)
	}
	if result.Outcome != "removed" || result.FilesRemoved != 5 || result.InvalidationID == "" {
		t.Fatalf("RemoveApp() = %+v; want five app objects removed and cache revalidated", result)
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
	if len(backend.store.invalidations) != 1 || !reflect.DeepEqual(backend.store.invalidations[0], applicationRemovalInvalidationPaths) {
		t.Fatalf("invalidations = %v; want exact app paths %v", backend.store.invalidations, applicationRemovalInvalidationPaths)
	}
	assertAppCacheRetryPresent(t, backend.store, false)
}

func TestRemoveAppDoesNotReportPlannedDeletesBeforeJournalOrValidation(t *testing.T) {
	for _, test := range []struct {
		name    string
		fault   func(*appRemoveFaultBackend)
		wantErr string
	}{
		{name: "validation", fault: func(backend *appRemoveFaultBackend) { backend.validationErr = errors.New("invalidation rejected") }, wantErr: "invalidation rejected"},
		{name: "journal write", fault: func(backend *appRemoveFaultBackend) { backend.failRetryWrite = true }, wantErr: "app retry journal CAS failure"},
	} {
		t.Run(test.name, func(t *testing.T) {
			base := newAppCachePublishBackend()
			seedAppRemoveObjects(t, base, "index.html", "assets/app.js")
			backend := &appRemoveFaultBackend{appCachePublishBackend: base}
			test.fault(backend)
			result, err := RemoveApp(context.Background(), backend, AppRemoveOptions{})
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("RemoveApp() error = %v; want %q", err, test.wantErr)
			}
			if result.FilesRemoved != 0 {
				t.Fatalf("failure reported filesRemoved=%d despite no completed object deletion", result.FilesRemoved)
			}
			if len(base.store.deletions) != 0 || len(base.store.invalidations) != 0 {
				t.Fatalf("pre-delete failure caused deletes or invalidations: %v / %v", base.store.deletions, base.store.invalidations)
			}
			for _, key := range []string{"index.html", "assets/app.js"} {
				if _, _, err := base.store.objects.GetObject(context.Background(), key); err != nil {
					t.Errorf("%q removed before failure: %v", key, err)
				}
			}
		})
	}
}

func TestDeployAppReplaysPendingAppRemovalCachePaths(t *testing.T) {
	base := newAppCachePublishBackend()
	seedAppRemoveObjects(t, base, "index.html", "assets/app.js")
	base.failInvalidation = true
	removed, err := RemoveApp(context.Background(), base, AppRemoveOptions{})
	if err == nil || removed.FilesRemoved != 2 {
		t.Fatalf("RemoveApp() = %+v, %v; want completed deletes and retryable invalidation failure", removed, err)
	}
	assertAppCacheRetryPresent(t, base.store, true)

	archive := createWebBundle(t, map[string][]byte{"index.html": []byte("<script src=\"/assets/app.js\"></script>"), "assets/app.js": []byte("window.app=true")})
	base.failInvalidation = false
	result, err := DeployApp(context.Background(), base, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("DeployApp() after remove error = %v", err)
	}
	wantPaths := []string{"/LICENSE", "/THIRD_PARTY_NOTICES.txt", "/assets/*", "/index.html", "/preview-bridge.js"}
	if result.Outcome != "deployed" || result.InvalidationID == "" || !reflect.DeepEqual(result.InvalidationPaths, wantPaths) {
		t.Fatalf("DeployApp() after removal = %+v; want deploy and replay of removal cache paths", result)
	}
	assertAppCacheRetryPresent(t, base.store, false)
}

func TestRemoveAppRetriesPartialDeleteAndAmbiguousJournalClear(t *testing.T) {
	for _, test := range []struct {
		name  string
		fault func(*appCachePublishBackend)
	}{
		{name: "partial delete", fault: func(backend *appCachePublishBackend) { backend.partialDeleteOnce = true }},
		{name: "clear before persistence", fault: func(backend *appCachePublishBackend) { backend.failClearBeforeDelete = true }},
		{name: "clear response lost", fault: func(backend *appCachePublishBackend) { backend.failClearAfterDelete = true }},
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
