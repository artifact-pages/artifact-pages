package publisher

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
)

func TestPublishSitePrunesOnlyMissingPreviewManifestsAfterProductionCommit(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)

	missing := previewPublishGroup("42", "0123456789abcdef0123456789abcdef01234567")
	liveMerged := previewPublishGroup("43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	liveClosed := previewPublishGroup("44", "2222222222222222222222222222222222222222")
	liveOpen := previewPublishGroup("45", "4444444444444444444444444444444444444444")
	liveManual := previewPublishManualGroup("3333333333333333333333333333333333333333")
	// PR lifecycle is deliberately absent from the catalog. These fixture names
	// document that live manifests survive regardless of PR state.
	seedPreviewPublishCatalog(t, backend.lockMemoryBackend, []preview.Group{missing, liveMerged, liveClosed, liveOpen, liveManual}, liveMerged.HeadSHA, liveClosed.HeadSHA, liveOpen.HeadSHA, liveManual.HeadSHA)

	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("PublishSite() error = %v", err)
	}
	wantPreviewChanges := []preview.CatalogReconciliationChange{
		{Action: "keep", GroupID: liveManual.ID, HeadSHA: liveManual.HeadSHA, Reason: "manifest-present"},
		{Action: "remove", GroupID: missing.ID, HeadSHA: missing.HeadSHA, Reason: "manifest-missing"},
		{Action: "keep", GroupID: liveMerged.ID, HeadSHA: liveMerged.HeadSHA, Reason: "manifest-present"},
		{Action: "keep", GroupID: liveClosed.ID, HeadSHA: liveClosed.HeadSHA, Reason: "manifest-present"},
		{Action: "keep", GroupID: liveOpen.ID, HeadSHA: liveOpen.HeadSHA, Reason: "manifest-present"},
	}
	if result.Outcome != "published" || !reflect.DeepEqual(previewChangesFromResult(result), wantPreviewChanges) {
		t.Fatalf("PublishSite() = %+v, want published with preview plan %+v", result, wantPreviewChanges)
	}
	if !strings.Contains(strings.Join(result.InvalidationPaths, "\n"), "/_previews/sre/catalog.json") {
		t.Fatal("pruned preview catalog was not included in cache revalidation")
	}

	finalCatalog := readPreviewPublishCatalog(t, backend.lockMemoryBackend, "sre")
	if len(finalCatalog.Groups) != 4 || finalCatalog.Groups[0].ID != liveMerged.ID || finalCatalog.Groups[1].ID != liveClosed.ID || finalCatalog.Groups[2].ID != liveOpen.ID || finalCatalog.Groups[3].ID != liveManual.ID {
		t.Fatalf("preview groups after production publish = %#v, want live PR and manual groups retained", finalCatalog.Groups)
	}

	// PR state is intentionally not stored in the catalog. Live manifests are
	// retained regardless of whether a PR is merged or closed.
	putPositions := make(map[string]int)
	for index, event := range backend.eventSnapshot() {
		if strings.HasPrefix(event, "put:") {
			putPositions[strings.TrimPrefix(event, "put:")] = index
		}
	}
	catalogPosition, catalogWritten := putPositions["_previews/sre/catalog.json"]
	if !catalogWritten {
		t.Fatalf("preview catalog was not written; put events=%v", backend.eventSnapshot())
	}
	for _, productionKey := range []string{"_indexes/sre/index.json", "_indexes/sre/meta.json"} {
		position, exists := putPositions[productionKey]
		if !exists {
			t.Fatalf("production projection %q was not committed; put events=%v", productionKey, backend.eventSnapshot())
		}
		if position >= catalogPosition {
			t.Fatalf("preview catalog was written before production object %q; put events=%v", productionKey, backend.eventSnapshot())
		}
	}
}

func TestPublishSiteDryRunReportsStalePreviewReferencesWithoutWrites(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	missing := previewPublishGroup("42", "0123456789abcdef0123456789abcdef01234567")
	live := previewPublishGroup("43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	seedPreviewPublishCatalog(t, backend.lockMemoryBackend, []preview.Group{missing, live}, live.HeadSHA)

	before := snapshotPreviewPublishObjects(backend.lockMemoryBackend)
	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", DryRun: true})
	if err != nil {
		t.Fatalf("PublishSite(dry-run) error = %v", err)
	}
	wantPreviewChanges := []preview.CatalogReconciliationChange{
		{Action: "remove", GroupID: missing.ID, HeadSHA: missing.HeadSHA, Reason: "manifest-missing"},
		{Action: "keep", GroupID: live.ID, HeadSHA: live.HeadSHA, Reason: "manifest-present"},
	}
	if result.Outcome != "planned" || !reflect.DeepEqual(previewChangesFromResult(result), wantPreviewChanges) {
		t.Fatalf("PublishSite(dry-run) = %+v, want planned preview changes %+v", result, wantPreviewChanges)
	}
	if after := snapshotPreviewPublishObjects(backend.lockMemoryBackend); !reflect.DeepEqual(after, before) {
		t.Fatalf("dry-run changed deployed objects: before=%v after=%v", objectKeys(before), objectKeys(after))
	}
	for _, event := range backend.eventSnapshot() {
		if strings.HasPrefix(event, "put:") || strings.HasPrefix(event, "delete:") {
			t.Fatalf("dry-run issued a write or delete: %v", backend.eventSnapshot())
		}
	}
	if keys, err := backend.lockMemoryBackend.ListKeys(context.Background(), "_control/locks/"); err != nil || len(keys) != 0 {
		t.Fatalf("dry-run lock objects = %v, err=%v; want no lock writes", keys, err)
	}
}

func TestPublishSiteProductionWriteFailureLeavesPreviewCatalogUnchanged(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	missing := previewPublishGroup("42", "0123456789abcdef0123456789abcdef01234567")
	live := previewPublishGroup("43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	seedPreviewPublishCatalog(t, backend.lockMemoryBackend, []preview.Group{missing, live}, live.HeadSHA)
	catalogKey, _ := preview.CatalogKey("sre")
	catalogBefore, _, err := backend.lockMemoryBackend.GetObject(context.Background(), strings.TrimPrefix(catalogKey, "/"))
	if err != nil {
		t.Fatal(err)
	}
	backend.failPutKey = "_indexes/sre/meta.json"

	if _, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}); err == nil {
		t.Fatal("PublishSite() succeeded after an injected production metadata write failure")
	}
	catalogAfter, _, err := backend.lockMemoryBackend.GetObject(context.Background(), strings.TrimPrefix(catalogKey, "/"))
	if err != nil || !bytes.Equal(catalogAfter.Bytes, catalogBefore.Bytes) {
		t.Fatalf("preview catalog changed after failed production write: bytesEqual=%v err=%v", bytes.Equal(catalogAfter.Bytes, catalogBefore.Bytes), err)
	}
	for _, event := range backend.eventSnapshot() {
		if event == "put:_previews/sre/catalog.json" {
			t.Fatalf("preview catalog was written after production failure: %v", backend.eventSnapshot())
		}
	}
}

func TestPublishSiteRetriesPreviewCatalogWriteFailureToConvergence(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	missing := previewPublishGroup("42", "0123456789abcdef0123456789abcdef01234567")
	live := previewPublishGroup("43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	seedPreviewPublishCatalog(t, backend.lockMemoryBackend, []preview.Group{missing, live}, live.HeadSHA)
	catalogKey, _ := preview.CatalogKey("sre")
	catalogBefore, _, err := backend.lockMemoryBackend.GetObject(context.Background(), strings.TrimPrefix(catalogKey, "/"))
	if err != nil {
		t.Fatal(err)
	}
	backend.failPutKey = "_previews/sre/catalog.json"

	first, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || !strings.Contains(err.Error(), "preview catalog reconciliation failed") {
		t.Fatalf("first PublishSite() error = %v, want retryable preview catalog error", err)
	}
	wantPreviewChanges := []preview.CatalogReconciliationChange{
		{Action: "remove", GroupID: missing.ID, HeadSHA: missing.HeadSHA, Reason: "manifest-missing"},
		{Action: "keep", GroupID: live.ID, HeadSHA: live.HeadSHA, Reason: "manifest-present"},
	}
	if !reflect.DeepEqual(previewChangesFromResult(first), wantPreviewChanges) {
		t.Fatalf("failed PublishSite() preview changes = %+v, want %+v", previewChangesFromResult(first), wantPreviewChanges)
	}
	for _, key := range []string{"_artifacts/sre/report.html", "_indexes/sre/index.json", "_indexes/sre/meta.json"} {
		if _, _, readErr := backend.lockMemoryBackend.GetObject(context.Background(), key); readErr != nil {
			t.Fatalf("production object %q missing after catalog failure: %v", key, readErr)
		}
	}
	catalogAfterFailure, _, err := backend.lockMemoryBackend.GetObject(context.Background(), strings.TrimPrefix(catalogKey, "/"))
	if err != nil || !bytes.Equal(catalogAfterFailure.Bytes, catalogBefore.Bytes) {
		t.Fatalf("preview catalog changed after failed catalog write: bytesEqual=%v err=%v", bytes.Equal(catalogAfterFailure.Bytes, catalogBefore.Bytes), err)
	}

	backend.resetEvents()
	retry, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("retry PublishSite() error = %v", err)
	}
	if retry.Outcome != "published" || !reflect.DeepEqual(previewChangesFromResult(retry), wantPreviewChanges) {
		t.Fatalf("retry PublishSite() = %+v, want published after preview pruning", retry)
	}
	finalCatalog := readPreviewPublishCatalog(t, backend.lockMemoryBackend, "sre")
	if len(finalCatalog.Groups) != 1 || finalCatalog.Groups[0].ID != live.ID {
		t.Fatalf("preview catalog after retry = %#v, want only live group retained", finalCatalog.Groups)
	}
	for _, event := range backend.eventSnapshot() {
		if strings.HasPrefix(event, "put:_artifacts/") || strings.HasPrefix(event, "put:_indexes/sre/") {
			t.Fatalf("retry did not converge to a production no-op: events=%v", backend.eventSnapshot())
		}
	}
}

func TestPublishSiteRejectsPreviewReconciliationAfterLockRecovery(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := &sitePublishLockRecoveryBackend{siteReconcileBackend: newSiteReconcileBackend()}
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	missing := previewPublishGroup("42", "0123456789abcdef0123456789abcdef01234567")
	live := previewPublishGroup("43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	seedPreviewPublishCatalog(t, backend.lockMemoryBackend, []preview.Group{missing, live}, live.HeadSHA)
	catalogKey, _ := preview.CatalogKey("sre")
	catalogBefore, _, err := backend.lockMemoryBackend.GetObject(context.Background(), providerObjectKey(catalogKey))
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if backend.replacementRelease != nil {
			if releaseErr := backend.replacementRelease(); releaseErr != nil {
				t.Errorf("release replacement site lock: %v", releaseErr)
			}
		}
	}()

	_, err = PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || !strings.Contains(err.Error(), "preview catalog reconciliation failed") || !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("PublishSite() after lock recovery error = %v, want a lock-loss reconciliation failure", err)
	}
	if backend.replacementRelease == nil {
		t.Fatal("test did not recover and reacquire the site lock during production publishing")
	}
	catalogAfter, _, err := backend.lockMemoryBackend.GetObject(context.Background(), providerObjectKey(catalogKey))
	if err != nil || !bytes.Equal(catalogAfter.Bytes, catalogBefore.Bytes) {
		t.Fatalf("preview catalog after lock loss = bytesEqual %t, err=%v; want the original catalog", bytes.Equal(catalogAfter.Bytes, catalogBefore.Bytes), err)
	}
	for _, event := range backend.eventSnapshot() {
		if event == "put:_previews/sre/catalog.json" {
			t.Fatalf("stale publisher replaced the preview catalog after lock recovery: %v", backend.eventSnapshot())
		}
	}
}

// sitePublishLockRecoveryBackend simulates an administrator recovering the
// current site lock and a different publisher taking ownership immediately
// before preview-catalog reconciliation.
type sitePublishLockRecoveryBackend struct {
	*siteReconcileBackend
	replacementRelease func() error
}

func (backend *sitePublishLockRecoveryBackend) PutObject(ctx context.Context, key string, object Object) error {
	if err := backend.siteReconcileBackend.PutObject(ctx, key, object); err != nil {
		return err
	}
	if key != "_indexes/sre/meta.json" || backend.replacementRelease != nil {
		return nil
	}
	manager := SiteLockManager{Backend: backend}
	snapshot, err := manager.Inspect(ctx, "sre")
	if err != nil {
		return err
	}
	if snapshot.State != "held" || snapshot.ETag == "" {
		return errors.New("site lock is not held before simulated recovery")
	}
	if err := manager.Recover(ctx, "sre", snapshot.ETag); err != nil {
		return err
	}
	_, release, err := manager.Acquire(ctx, "sre")
	if err != nil {
		return err
	}
	backend.replacementRelease = release
	return nil
}

func previewChangesFromResult(result Result) []preview.CatalogReconciliationChange {
	if result.PreviewChanges == nil {
		return nil
	}
	return *result.PreviewChanges
}

func previewPublishGroup(prNumber, headSHA string) preview.Group {
	return preview.Group{
		ID: "pr:" + prNumber, Kind: "pull-request", HeadSHA: headSHA,
		PRURL:     "https://github.com/acme/sre/pull/" + prNumber,
		UpdatedAt: "2026-09-27T00:00:00Z",
		Documents: []preview.Document{{Path: "docs/report.md", Title: "Report", Format: "markdown"}},
	}
}

func previewPublishManualGroup(headSHA string) preview.Group {
	return preview.Group{
		ID: "head:" + headSHA, Kind: "manual", HeadSHA: headSHA,
		UpdatedAt: "2026-09-27T00:00:00Z",
		Documents: []preview.Document{{Path: "docs/report.md", Title: "Report", Format: "markdown"}},
	}
}

func seedPreviewPublishCatalog(t *testing.T, backend *lockMemoryBackend, groups []preview.Group, liveManifestHeads ...string) {
	t.Helper()
	contents, err := preview.EncodeCatalog(preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: "sre", Groups: groups})
	if err != nil {
		t.Fatalf("encode preview catalog fixture: %v", err)
	}
	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}
	seedMemoryObject(backend, strings.TrimPrefix(catalogKey, "/"), contents)
	for _, headSHA := range liveManifestHeads {
		manifestKey, err := preview.ManifestKey("sre", headSHA)
		if err != nil {
			t.Fatal(err)
		}
		seedMemoryObject(backend, strings.TrimPrefix(manifestKey, "/"), []byte("completed preview manifest"))
	}
}

func readPreviewPublishCatalog(t *testing.T, backend *lockMemoryBackend, site string) preview.Catalog {
	t.Helper()
	key, err := preview.CatalogKey(site)
	if err != nil {
		t.Fatal(err)
	}
	object, _, err := backend.GetObject(context.Background(), strings.TrimPrefix(key, "/"))
	if err != nil {
		t.Fatalf("read preview catalog fixture: %v", err)
	}
	catalog, err := preview.DecodeCatalog(object.Bytes)
	if err != nil {
		t.Fatalf("decode preview catalog fixture: %v", err)
	}
	return catalog
}

func snapshotPreviewPublishObjects(backend *lockMemoryBackend) map[string]Object {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	objects := make(map[string]Object, len(backend.objects))
	for key, object := range backend.objects {
		object.Bytes = bytes.Clone(object.Bytes)
		if object.Metadata != nil {
			metadata := make(map[string]string, len(object.Metadata))
			for name, value := range object.Metadata {
				metadata[name] = value
			}
			object.Metadata = metadata
		}
		objects[key] = object
	}
	return objects
}

func objectKeys(objects map[string]Object) []string {
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	return keys
}
