package publisher

import (
	"context"
	"encoding/json"
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

	conditionalWrites       map[string]int
	persistThenErrorKey     string
	persistThenErrorAt      int
	persistThenErrorUsed    bool
	failProjectionOnce      bool
	observeMigrationIntent  bool
	migrationIntentBeforeIO bool
	migrationObserveError   string
	projectionAttempts      []string
	projectionWrites        []string
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
	fail := backend.failProjectionOnce
	backend.failProjectionOnce = false
	observeMigration := backend.observeMigrationIntent
	backend.mu.Unlock()

	if observeMigration {
		ready, err := sitePublishV2RecoveryMigrationIntentIsDurable(ctx, backend.sitePublishScaleBackend)
		backend.mu.Lock()
		backend.migrationIntentBeforeIO = ready
		if err != nil {
			backend.migrationObserveError = err.Error()
		}
		backend.mu.Unlock()
	}
	if fail {
		return errors.New("injected projection interruption before origin write")
	}
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

func (backend *sitePublishV2RecoveryBackend) conditionalWriteSnapshot() (stateWrites, journalWrites int) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.conditionalWrites[sitePublishStateKey("sre")], backend.conditionalWrites[siteCacheRetryKey("sre")]
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

func sitePublishV2RecoverySeedLegacyState(t *testing.T, store *sitePublishScaleBackend, pending []string) sitePublishState {
	t.Helper()
	state, _, _ := sitePublishV2RecoveryReadState(t, store)
	state.SchemaVersion = sitePublishStateLegacySchemaVersion
	state.Committed.Generation = ""
	state.Pending = nil
	if pending != nil {
		state.Pending = &sitePublishPending{TouchedKeys: append([]string(nil), pending...)}
	}
	compressed, err := encodeSitePublishState(state)
	if err != nil {
		t.Fatalf("encode legacy publish state: %v", err)
	}
	pendingMetadata := "false"
	if state.Pending != nil {
		pendingMetadata = "true"
	}
	object := Object{
		Bytes: compressed, ContentType: "application/octet-stream", ContentDisposition: "inline", Cache: sitePublishStateCacheControl,
		Metadata: map[string]string{
			"artifact-pages-publish-state-schema": "1",
			"artifact-pages-publish-input-root":   state.Committed.InputRoot,
			"artifact-pages-publish-pending":      pendingMetadata,
			"artifact-pages-sha256":               sha256Hex(compressed),
			"artifact-pages-site":                 "sre",
		},
	}
	store.lockMemoryBackend.mu.Lock()
	store.lockMemoryBackend.objects[sitePublishStateKey("sre")] = object
	store.lockMemoryBackend.etags[sitePublishStateKey("sre")] = `"recovery-v1-state"`
	store.lockMemoryBackend.mu.Unlock()
	return state
}

func sitePublishV2RecoverySeedLegacyJournal(t *testing.T, store *sitePublishScaleBackend, paths []string) {
	t.Helper()
	record := siteCacheRetry{SchemaVersion: siteCacheRetryLegacySchemaVersion, Paths: append([]string(nil), paths...)}
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("encode legacy cache retry journal: %v", err)
	}
	key := siteCacheRetryKey("sre")
	store.lockMemoryBackend.mu.Lock()
	store.lockMemoryBackend.objects[key] = Object{Bytes: data, ContentType: "application/json; charset=utf-8", Cache: "no-store"}
	store.lockMemoryBackend.etags[key] = `"recovery-v1-journal"`
	store.lockMemoryBackend.mu.Unlock()
}

func sitePublishV2RecoveryChangePage(t *testing.T, root, contents string) {
	t.Helper()
	page := filepath.Join(root, "docs", "artifacts", "report.html")
	if err := os.WriteFile(page, []byte(contents), 0o600); err != nil {
		t.Fatalf("change source page: %v", err)
	}
}

func TestPublishSiteV1CleanNoOpKeepsLegacyStateWithoutWrites(t *testing.T) {
	_, store, options := sitePublishV2RecoveryFixture(t)
	sitePublishV2RecoverySeedLegacyState(t, store, nil)
	backend := newSitePublishV2RecoveryBackend(store)

	result, err := PublishSite(context.Background(), backend, options)
	if err != nil || result.Outcome != "no-op" || !result.BuildSkipped {
		t.Fatalf("legacy-state no-op = %+v, err=%v; want build-skipped no-op", result, err)
	}
	state, _, _ := sitePublishV2RecoveryReadState(t, store)
	if state.SchemaVersion != sitePublishStateLegacySchemaVersion || state.Pending != nil {
		t.Fatalf("legacy state after no-op = %+v; want clean schema v1", state)
	}
	stateWrites, journalWrites := backend.conditionalWriteSnapshot()
	if stateWrites != 0 || journalWrites != 0 {
		t.Fatalf("state/journal conditional writes = %d/%d; want none", stateWrites, journalWrites)
	}
	attempts, writes := backend.projectionWriteSnapshot()
	if len(attempts) != 0 || len(writes) != 0 {
		t.Fatalf("projection attempts/writes = %v/%v; want none", attempts, writes)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("legacy-state no-op cache journal error = %v; want missing journal", err)
	}
}

func TestPublishSiteChangedSourceUpgradesLegacyStateToV2(t *testing.T) {
	root, store, options := sitePublishV2RecoveryFixture(t)
	sitePublishV2RecoverySeedLegacyState(t, store, nil)
	sitePublishV2RecoveryChangePage(t, root, "<title>Legacy migration</title><h1>Changed from v1</h1>")
	backend := newSitePublishV2RecoveryBackend(store)

	result, err := PublishSite(context.Background(), backend, options)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("changed legacy publish = %+v, err=%v", result, err)
	}
	state, _, _ := sitePublishV2RecoveryReadState(t, store)
	if state.SchemaVersion != sitePublishStateSchemaVersion || state.Pending != nil || !sitePublishStateHashPattern.MatchString(state.Committed.Generation) {
		t.Fatalf("changed legacy publish state = %+v; want clean v2 committed state", state)
	}
	if got := store.objectBytes("_artifacts/sre/report.html"); !strings.Contains(got, "Changed from v1") {
		t.Fatalf("published page = %q; want changed legacy source", got)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("cache journal after v1-to-v2 publish = %v; want cleared", err)
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
	if finalState.SchemaVersion != sitePublishStateSchemaVersion || finalState.Pending != nil || finalState.Committed.Generation != journal.Transaction.ID {
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

func TestPublishSiteLegacyPendingAndJournalMigrateIntentBeforeOriginWrites(t *testing.T) {
	root, store, options := sitePublishV2RecoveryFixture(t)
	touchedPage := "_artifacts/sre/report.html"
	sitePublishV2RecoverySeedLegacyState(t, store, []string{touchedPage})
	sitePublishV2RecoverySeedLegacyJournal(t, store, []string{"/_artifacts/sre/report.html"})
	sitePublishV2RecoveryChangePage(t, root, "<title>Legacy pending recovery</title><h1>Latest after restart</h1>")

	first := newSitePublishV2RecoveryBackend(store)
	first.failProjectionOnce = true
	first.observeMigrationIntent = true
	if _, err := PublishSite(context.Background(), first, options); err == nil || !strings.Contains(err.Error(), "injected projection interruption") {
		t.Fatalf("legacy pending publish interruption = %v; want first origin write interruption", err)
	}
	first.mu.Lock()
	migratedIntent, migrationErr := first.migrationIntentBeforeIO, first.migrationObserveError
	first.mu.Unlock()
	if !migratedIntent {
		t.Fatalf("v2 retry intent was not durable over v1 pending state before origin write; observation error %q", migrationErr)
	}
	if attempts, writes := first.projectionWriteSnapshot(); len(attempts) != 1 || len(writes) != 0 {
		t.Fatalf("interrupted migration projection attempts/writes = %v/%v; want one attempted and zero successful origin writes", attempts, writes)
	}
	legacyPending, _, _ := sitePublishV2RecoveryReadState(t, store)
	if legacyPending.SchemaVersion != sitePublishStateLegacySchemaVersion || legacyPending.Pending == nil {
		t.Fatalf("state after interrupted legacy migration = %+v; want preserved v1 pending baseline", legacyPending)
	}
	journal, _ := sitePublishV2RecoveryReadCache(t, store)
	if journal.SchemaVersion != siteCacheRetrySchemaVersion || journal.Transaction == nil ||
		journal.Transaction.BaseGeneration != legacyPending.Committed.Generation || !containsString(journal.Transaction.TouchedKeys, touchedPage) {
		t.Fatalf("migrated retry journal = %+v; want v2 transaction retaining touched legacy key", journal)
	}

	restarted := newSitePublishV2RecoveryBackend(store)
	result, err := PublishSite(context.Background(), restarted, options)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("fresh-wrapper legacy migration retry = %+v, err=%v", result, err)
	}
	finalState, _, _ := sitePublishV2RecoveryReadState(t, store)
	if finalState.SchemaVersion != sitePublishStateSchemaVersion || finalState.Pending != nil || finalState.Committed.Generation != journal.Transaction.ID {
		t.Fatalf("state after legacy migration retry = %+v; want committed v2 transaction", finalState)
	}
	if got := store.objectBytes("_artifacts/sre/report.html"); !strings.Contains(got, "Latest after restart") {
		t.Fatalf("legacy pending recovered page = %q; want latest source", got)
	}
	if attempts, writes := restarted.projectionWriteSnapshot(); len(attempts) == 0 || len(writes) == 0 {
		t.Fatalf("legacy migration retry projection attempts/writes = %v/%v; want origin writes", attempts, writes)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("legacy migration cache journal after retry = %v; want cleared", err)
	}
}

func sitePublishV2RecoveryMigrationIntentIsDurable(ctx context.Context, store *sitePublishScaleBackend) (bool, error) {
	stateObject, etag, err := store.lockMemoryBackend.GetObject(ctx, sitePublishStateKey("sre"))
	if err != nil {
		return false, err
	}
	stateInfo, err := store.lockMemoryBackend.HeadObject(ctx, sitePublishStateKey("sre"))
	if err != nil {
		return false, err
	}
	if etag != stateInfo.ETag {
		return false, errors.New("state ETag changed during pre-origin observation")
	}
	state, err := decodeSitePublishState("sre", stateInfo, stateObject.Bytes)
	if err != nil {
		return false, err
	}
	journal, _, err := readSiteCacheRetry(ctx, store.lockMemoryBackend, "sre")
	if err != nil {
		return false, err
	}
	return state.SchemaVersion == sitePublishStateLegacySchemaVersion && state.Pending != nil &&
		journal.SchemaVersion == siteCacheRetrySchemaVersion && journal.Transaction != nil &&
		journal.Transaction.BaseGeneration == state.Committed.Generation, nil
}
