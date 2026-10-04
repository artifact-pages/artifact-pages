package publisher

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// sitePublishV2RecoveryBackend keeps the object store across wrapper instances
// while allowing tests to model a response lost after a conditional write was
// durably applied. A new wrapper represents a process restart.
type sitePublishV2RecoveryBackend struct {
	*sitePublishScaleBackend

	mu sync.Mutex

	conditionalWrites    map[string]int
	persistThenErrorKey  string
	persistThenErrorAt   int
	persistThenErrorUsed bool
	projectionAttempts   []string
	projectionWrites     []string
}

func newSitePublishV2RecoveryBackend(store *sitePublishScaleBackend) *sitePublishV2RecoveryBackend {
	return &sitePublishV2RecoveryBackend{
		sitePublishScaleBackend: store,
		conditionalWrites:       make(map[string]int),
	}
}

func (backend *sitePublishV2RecoveryBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.mu.Lock()
	backend.conditionalWrites[key]++
	attempt := backend.conditionalWrites[key]
	persistThenError := key == backend.persistThenErrorKey && !backend.persistThenErrorUsed &&
		(backend.persistThenErrorAt == 0 || attempt == backend.persistThenErrorAt)
	if persistThenError {
		backend.persistThenErrorUsed = true
	}
	backend.mu.Unlock()

	etag, err := backend.sitePublishScaleBackend.PutObjectConditional(ctx, key, object, condition)
	if err != nil {
		return etag, err
	}
	if persistThenError {
		return "", fmt.Errorf("injected response error after persisted conditional write to %s", key)
	}
	return etag, nil
}

func (backend *sitePublishV2RecoveryBackend) PutObject(ctx context.Context, key string, object Object) error {
	if !sitePublishV2RecoveryProjectionKey(key) {
		return backend.sitePublishScaleBackend.PutObject(ctx, key, object)
	}

	backend.mu.Lock()
	backend.projectionAttempts = append(backend.projectionAttempts, key)
	backend.mu.Unlock()
	if err := backend.sitePublishScaleBackend.PutObject(ctx, key, object); err != nil {
		return err
	}
	backend.mu.Lock()
	backend.projectionWrites = append(backend.projectionWrites, key)
	backend.mu.Unlock()
	return nil
}

func (backend *sitePublishV2RecoveryBackend) DeleteObjects(ctx context.Context, keys []string) error {
	for _, key := range keys {
		if sitePublishV2RecoveryProjectionKey(key) {
			backend.mu.Lock()
			backend.projectionAttempts = append(backend.projectionAttempts, "delete:"+key)
			backend.mu.Unlock()
		}
	}
	if err := backend.sitePublishScaleBackend.DeleteObjects(ctx, keys); err != nil {
		return err
	}
	backend.mu.Lock()
	for _, key := range keys {
		if sitePublishV2RecoveryProjectionKey(key) {
			backend.projectionWrites = append(backend.projectionWrites, "delete:"+key)
		}
	}
	backend.mu.Unlock()
	return nil
}

func (backend *sitePublishV2RecoveryBackend) projectionWriteSnapshot() (attempts, writes []string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return append([]string(nil), backend.projectionAttempts...), append([]string(nil), backend.projectionWrites...)
}

func sitePublishV2RecoveryProjectionKey(key string) bool {
	return strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/")
}

func sitePublishV2RecoveryFixture(t *testing.T) (string, *sitePublishScaleBackend, SitePublishOptions) {
	t.Helper()
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	store := newSitePublishScaleBackend()
	seedPublisherRegistry(t, store.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	backend := newSitePublishV2RecoveryBackend(store)
	result, err := PublishSite(context.Background(), backend, options)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("initial PublishSite() = %+v, err=%v", result, err)
	}
	state, _, _ := sitePublishV2RecoveryReadState(t, store)
	if state.SchemaVersion != sitePublishStateSchemaVersion {
		t.Fatalf("initial state schema = %d, want v%d", state.SchemaVersion, sitePublishStateSchemaVersion)
	}
	return root, store, options
}

func sitePublishV2RecoveryReadState(t *testing.T, store *sitePublishScaleBackend) (sitePublishState, Object, ObjectInfo) {
	t.Helper()
	key := sitePublishStateKey("sre")
	object, etag, err := store.lockMemoryBackend.GetObject(context.Background(), key)
	if err != nil {
		t.Fatalf("read state object: %v", err)
	}
	info, err := store.lockMemoryBackend.HeadObject(context.Background(), key)
	if err != nil {
		t.Fatalf("HEAD state object: %v", err)
	}
	if info.ETag != etag {
		t.Fatalf("state HEAD ETag %q differs from GET ETag %q", info.ETag, etag)
	}
	state, err := decodeSitePublishState("sre", info, object.Bytes)
	if err != nil {
		t.Fatalf("decode state object: %v", err)
	}
	return state, object, info
}

func sitePublishV2RecoveryReadCache(t *testing.T, store *sitePublishScaleBackend) (siteCacheRetry, string) {
	t.Helper()
	record, etag, err := readSiteCacheRetry(context.Background(), store.lockMemoryBackend, "sre")
	if err != nil {
		t.Fatalf("read site cache retry record: %v", err)
	}
	return record, etag
}

func sitePublishV2RecoveryChangePage(t *testing.T, root, contents string) {
	t.Helper()
	page := filepath.Join(root, "docs", "artifacts", "report.html")
	if err := os.WriteFile(page, []byte(contents), 0o600); err != nil {
		t.Fatalf("change source page: %v", err)
	}
}

func TestPublishSitePersistedJournalErrorRecoversAfterFreshWrapper(t *testing.T) {
	root, store, options := sitePublishV2RecoveryFixture(t)
	committed, _, _ := sitePublishV2RecoveryReadState(t, store)
	before := sitePublishProjectionBytes(store.lockMemoryBackend, "sre")
	sitePublishV2RecoveryChangePage(t, root, "<title>Journal recovery</title><h1>Retry after durable intent</h1>")

	first := newSitePublishV2RecoveryBackend(store)
	first.persistThenErrorKey = siteCacheRetryKey("sre")
	first.persistThenErrorAt = 1
	if _, err := PublishSite(context.Background(), first, options); err == nil || !strings.Contains(err.Error(), "save site cache retry record") {
		t.Fatalf("publish with persisted journal response error = %v; want journal save error", err)
	}
	stateAfterError, _, _ := sitePublishV2RecoveryReadState(t, store)
	journal, _ := sitePublishV2RecoveryReadCache(t, store)
	if stateAfterError.Committed.Generation != committed.Committed.Generation || journal.Transaction == nil || journal.Transaction.BaseGeneration != committed.Committed.Generation {
		t.Fatalf("state/journal after persisted journal error = generation %q journal %+v; want old committed generation and durable based transaction", stateAfterError.Committed.Generation, journal.Transaction)
	}
	if got := sitePublishProjectionBytes(store.lockMemoryBackend, "sre"); !equalProjectionBytes(before, got) {
		t.Fatal("projection changed before the persisted journal response error returned")
	}
	if attempts, writes := first.projectionWriteSnapshot(); len(attempts) != 0 || len(writes) != 0 {
		t.Fatalf("first wrapper projection attempts/writes = %v/%v; want none before durable intent is acknowledged", attempts, writes)
	}

	// A fresh wrapper over the same object storage observes the durable v2
	// journal and resumes the original transaction.
	restarted := newSitePublishV2RecoveryBackend(store)
	result, err := PublishSite(context.Background(), restarted, options)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("fresh-wrapper journal retry = %+v, err=%v", result, err)
	}
	finalState, _, _ := sitePublishV2RecoveryReadState(t, store)
	if finalState.SchemaVersion != sitePublishStateSchemaVersion || finalState.Committed.Generation != journal.Transaction.ID {
		t.Fatalf("state after fresh-wrapper journal recovery = %+v; want committed v2 original transaction", finalState)
	}
	if got := store.objectBytes("_artifacts/sre/report.html"); !strings.Contains(got, "Retry after durable intent") {
		t.Fatalf("recovered page = %q; want latest source", got)
	}
	if attempts, writes := restarted.projectionWriteSnapshot(); len(attempts) == 0 || len(writes) == 0 {
		t.Fatalf("fresh-wrapper projection attempts/writes = %v/%v; want recovered projection work", attempts, writes)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("cache journal after recovery = %v; want cleared", err)
	}
}

func TestPublishSitePersistedFinalStateErrorRetriesCacheOnlyAfterFreshWrapper(t *testing.T) {
	root, store, options := sitePublishV2RecoveryFixture(t)
	sitePublishV2RecoveryChangePage(t, root, "<title>Final state recovery</title><h1>Committed with lost response</h1>")

	first := newSitePublishV2RecoveryBackend(store)
	first.persistThenErrorKey = sitePublishStateKey("sre")
	first.persistThenErrorAt = 1
	if _, err := PublishSite(context.Background(), first, options); err == nil || !strings.Contains(err.Error(), "commit site publish state after origin projection") {
		t.Fatalf("publish with persisted final-state response error = %v; want final commit error", err)
	}
	committedAfterError, _, _ := sitePublishV2RecoveryReadState(t, store)
	journal, _ := sitePublishV2RecoveryReadCache(t, store)
	if journal.Transaction == nil || committedAfterError.Committed.Generation != journal.Transaction.ID {
		t.Fatalf("state/journal after persisted final-state error = generation %q transaction %+v; want transaction committed with retry marker", committedAfterError.Committed.Generation, journal.Transaction)
	}
	if attempts, writes := first.projectionWriteSnapshot(); len(attempts) == 0 || len(writes) == 0 {
		t.Fatalf("first-wrapper projection attempts/writes = %v/%v; want completed origin projection", attempts, writes)
	}

	restarted := newSitePublishV2RecoveryBackend(store)
	result, err := PublishSite(context.Background(), restarted, options)
	if err != nil || result.Outcome != "published" || !result.BuildSkipped {
		t.Fatalf("fresh-wrapper cache-only retry = %+v, err=%v; want published BuildSkipped result", result, err)
	}
	if attempts, writes := restarted.projectionWriteSnapshot(); len(attempts) != 0 || len(writes) != 0 {
		t.Fatalf("cache-only retry projection attempts/writes = %v/%v; want none", attempts, writes)
	}
	finalState, _, _ := sitePublishV2RecoveryReadState(t, store)
	if finalState.Committed.Generation != journal.Transaction.ID || finalState.SchemaVersion != sitePublishStateSchemaVersion {
		t.Fatalf("cache-only retry changed committed state = %+v; want existing transaction generation", finalState.Committed)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("cache journal after cache-only retry = %v; want cleared", err)
	}
}
