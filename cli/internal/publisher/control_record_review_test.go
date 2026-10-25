package publisher

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

// damagedControlRecords are bodies whose schemaVersion is missing, null,
// non-integer, or whose top level is not an object. Every control-record reader
// must reject them with an ordinary (non-compat) error rather than treat them
// as an absent record.
var damagedControlRecords = map[string]string{
	"missing schemaVersion": `{"site":"sre","paths":[]}`,
	"null schemaVersion":    `{"schemaVersion":null}`,
	"string schemaVersion":  `{"schemaVersion":"2"}`,
	"top-level null":        `null`,
	"top-level array":       `[]`,
}

func requireOrdinaryError(t *testing.T, name string, err error) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: damaged record was accepted", name)
	}
	if compat.Is(err) {
		t.Fatalf("%s: damaged record reported as a compat error: %v", name, err)
	}
}

func TestControlRecordReadersRejectDamagedSchemaVersionWithOrdinaryError(t *testing.T) {
	ctx := context.Background()
	for name, raw := range damagedControlRecords {
		t.Run("site cache/"+name, func(t *testing.T) {
			b := newLockMemoryBackend()
			seedMemoryObject(b, siteCacheRetryKey("sre"), []byte(raw))
			_, _, err := readSiteCacheRetry(ctx, b, "sre")
			requireOrdinaryError(t, name, err)
		})
		t.Run("registry cleanup/"+name, func(t *testing.T) {
			b := newRegistryApplyTestBackend()
			b.seed(registryCleanupKey, []byte(raw))
			_, _, err := readRegistryCleanup(ctx, b)
			requireOrdinaryError(t, name, err)
		})
		t.Run("app cache retry/"+name, func(t *testing.T) {
			b := newLockMemoryBackend()
			seedMemoryObject(b, appCacheRetryObjectKey, []byte(raw))
			_, _, err := readAppCacheRetry(ctx, b)
			requireOrdinaryError(t, name, err)
		})
		t.Run("preview cleanup/"+name, func(t *testing.T) {
			b := newLockMemoryBackend()
			seedMemoryObject(b, previewCleanupKey("sre"), []byte(raw))
			record, _, err := readPreviewCleanup(ctx, b, "sre")
			requireOrdinaryError(t, name, err)
			if record != nil {
				t.Fatalf("%s: returned a record %+v", name, record)
			}
		})
	}
}

func TestPublishSiteFailsOverDamagedSiteCacheJournal(t *testing.T) {
	for name, raw := range damagedControlRecords {
		t.Run(name, func(t *testing.T) {
			_, store, options := sitePublishRecoveryFixture(t)
			seedMemoryObject(store.lockMemoryBackend, siteCacheRetryKey("sre"), []byte(raw))
			before, beforeETags := snapshotLockMemory(store.lockMemoryBackend)
			result, err := PublishSite(context.Background(), newSitePublishRecoveryBackend(store), options)
			if err == nil {
				t.Fatalf("PublishSite over damaged journal = %+v; want failure, not a no-op", result)
			}
			if result.Outcome == "no-op" {
				t.Fatalf("PublishSite took the no-op path over a damaged journal: %+v", result)
			}
			requireOrdinaryError(t, name, err)
			after, afterETags := snapshotLockMemory(store.lockMemoryBackend)
			// The cooperative lock object is acquired and released by the attempt;
			// every other object and ETag must be untouched.
			lockKey := siteLockKey("sre")
			delete(before, lockKey)
			delete(after, lockKey)
			delete(beforeETags, lockKey)
			delete(afterETags, lockKey)
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeETags, afterETags) {
				t.Fatalf("object snapshot changed over damaged journal: %d -> %d objects", len(before), len(after))
			}
			if got := string(after[siteCacheRetryKey("sre")].Bytes); got != raw {
				t.Fatalf("damaged journal was rewritten to %q", got)
			}
		})
	}
}

func TestRegistryCleanupSchema1RequiresExactlyOneJSONValue(t *testing.T) {
	paths := legacyRegistryCleanupRequiredPaths(true, []string{"docs"})
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = fmt.Sprintf("%q", p)
	}
	one := `{"schemaVersion":1,"sites":["docs"],"paths":[` + strings.Join(quoted, ",") + `]}`
	b := newRegistryApplyTestBackend()
	b.seed(registryCleanupKey, []byte(one))
	if _, _, err := readRegistryCleanup(context.Background(), b); err != nil {
		t.Fatalf("single-value legacy record rejected: %v", err)
	}
	for _, trailing := range []string{one + `{}`, one + "\n" + one, one + " garbage"} {
		b.seed(registryCleanupKey, []byte(trailing))
		_, _, err := readRegistryCleanup(context.Background(), b)
		requireOrdinaryError(t, "trailing value", err)
		// The exactly-one-value property is enforced upstream, by the
		// duplicate-key validator (and readControlSchemaVersion, whose
		// json.Unmarshal also rejects trailing data), before the decoder's own
		// EOF check can run. The EOF check stays as defence in depth; this
		// asserts which layer fires.
		if err == nil || !strings.Contains(err.Error(), "validate registry cleanup record: trailing JSON") {
			t.Fatalf("trailing value error = %v; want the duplicate-key validator rejection", err)
		}
	}
}

// mutationLogBackend records every mutating call in order and can inject a
// crash right after a journal write persisted.
type mutationLogBackend struct {
	*sitePublishRecoveryBackend
	mu           sync.Mutex
	events       []string
	journalKey   string
	crashAfter   bool // fail after the first conditional journal write persisted
	crashed      bool
	failProjAt   int // when >0, projection PutObject number failProjAt (1-based) fails
	projPuts     int
	journalBodys []string
}

func (b *mutationLogBackend) log(event string) {
	b.mu.Lock()
	b.events = append(b.events, event)
	b.mu.Unlock()
}

func (b *mutationLogBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	etag, err := b.sitePublishRecoveryBackend.PutObjectConditional(ctx, key, object, condition)
	if err != nil {
		return etag, err
	}
	b.log("cond:" + key)
	if key == b.journalKey {
		b.mu.Lock()
		b.journalBodys = append(b.journalBodys, string(object.Bytes))
		crash := b.crashAfter && !b.crashed
		if crash {
			b.crashed = true
		}
		b.mu.Unlock()
		if crash {
			return "", errors.New("injected crash after journal rewrite")
		}
	}
	return etag, nil
}

func (b *mutationLogBackend) PutObject(ctx context.Context, key string, object Object) error {
	if sitePublishRecoveryProjectionKey(key) {
		b.mu.Lock()
		b.projPuts++
		fail := b.failProjAt > 0 && b.projPuts >= b.failProjAt
		b.mu.Unlock()
		if fail {
			return errors.New("injected projection failure")
		}
	}
	if err := b.sitePublishRecoveryBackend.PutObject(ctx, key, object); err != nil {
		return err
	}
	b.log("put:" + key)
	return nil
}

func (b *mutationLogBackend) DeleteObjects(ctx context.Context, keys []string) error {
	if err := b.sitePublishRecoveryBackend.DeleteObjects(ctx, keys); err != nil {
		return err
	}
	for _, key := range keys {
		b.log("delete:" + key)
	}
	return nil
}

func (b *mutationLogBackend) snapshotEvents() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]string(nil), b.events...)
}

func eventIndex(events []string, want string, last bool) int {
	found := -1
	for i, e := range events {
		if e == want {
			found = i
			if !last {
				return i
			}
		}
	}
	return found
}

func firstProjectionEvent(events []string) int {
	for i, e := range events {
		_, key, _ := strings.Cut(e, ":")
		if sitePublishRecoveryProjectionKey(key) {
			return i
		}
	}
	return -1
}

const previewCatalogKey = "_previews/sre/catalog.json"

func TestPublishSiteMigratesSchema1OriginTransactionBeforeProjectionAndRetriesFromSchema2(t *testing.T) {
	ctx := context.Background()
	root, store, options := sitePublishRecoveryFixture(t)
	committed, _, _ := sitePublishRecoveryReadState(t, store)
	sitePublishRecoveryChangePage(t, root, "<title>Legacy journal</title><h1>Schema one transaction</h1>")
	journalKey := siteCacheRetryKey("sre")

	// Produce a partly applied transaction: the journal is durable, the first
	// projection write landed, a later one failed, and state still names the
	// base generation.
	partial := &mutationLogBackend{sitePublishRecoveryBackend: newSitePublishRecoveryBackend(store), journalKey: journalKey, failProjAt: 2}
	if _, err := PublishSite(ctx, partial, options); err == nil {
		t.Fatal("partial publish unexpectedly succeeded")
	}
	if first := firstProjectionEvent(partial.snapshotEvents()); first < 0 {
		t.Fatal("partial publish wrote no projection key; the transaction is not partly applied")
	}
	stateAfterPartial, _, _ := sitePublishRecoveryReadState(t, store)
	journal, _ := sitePublishRecoveryReadCache(t, store)
	if journal.Transaction == nil || stateAfterPartial.Committed.Generation != committed.Committed.Generation || journal.Transaction.BaseGeneration != committed.Committed.Generation {
		t.Fatalf("partial state/journal = %q / %+v; want base generation and based transaction", stateAfterPartial.Committed.Generation, journal.Transaction)
	}
	tx := *journal.Transaction
	quotedKeys := make([]string, len(tx.TouchedKeys))
	for i, key := range tx.TouchedKeys {
		quotedKeys[i] = fmt.Sprintf("%q", key)
	}
	// Legacy paths must be sorted and limited to site-scoped projection paths.
	legacy := `{"schemaVersion":1,"site":"sre","paths":["/_artifacts/sre/report.html"],"transaction":{"id":"` + tx.ID + `","baseGeneration":"` + tx.BaseGeneration + `","touchedKeys":[` + strings.Join(quotedKeys, ",") + `]}}`
	seedMemoryObject(store.lockMemoryBackend, journalKey, []byte(legacy))
	if record, _, err := readSiteCacheRetry(ctx, store.lockMemoryBackend, "sre"); err != nil || !record.legacyRecord || record.Transaction == nil || record.Transaction.ID != tx.ID {
		t.Fatalf("seeded legacy journal = %+v, err=%v", record, err)
	}

	// Run 1: crash right after the schema 2 rewrite persisted.
	crash := &mutationLogBackend{sitePublishRecoveryBackend: newSitePublishRecoveryBackend(store), journalKey: journalKey, crashAfter: true}
	if _, err := PublishSite(ctx, crash, options); err == nil {
		t.Fatal("publish with injected crash unexpectedly succeeded")
	}
	events := crash.snapshotEvents()
	rewrite := eventIndex(events, "cond:"+journalKey, false)
	if rewrite < 0 {
		t.Fatalf("no CAS journal rewrite observed; events = %v", events)
	}
	if first := firstProjectionEvent(events); first >= 0 {
		t.Fatalf("projection write at event %d (%v) before or after the crashed rewrite; want none", first, events)
	}
	if len(crash.journalBodys) != 1 || !strings.Contains(crash.journalBodys[0], `"schemaVersion":2`) || strings.Contains(crash.journalBodys[0], `"paths"`) || !strings.Contains(crash.journalBodys[0], tx.ID) {
		t.Fatalf("journal rewrite body = %v; want schema 2 with the original transaction and no paths", crash.journalBodys)
	}
	rewritten, _ := sitePublishRecoveryReadCache(t, store)
	if rewritten.legacyRecord || rewritten.Transaction == nil || rewritten.Transaction.ID != tx.ID {
		t.Fatalf("journal after crash = %+v; want schema 2 carrying the original transaction", rewritten)
	}
	if state, _, _ := sitePublishRecoveryReadState(t, store); state.Committed.Generation != committed.Committed.Generation {
		t.Fatalf("state advanced during the crashed run: %q", state.Committed.Generation)
	}

	// Drop the version record so its staging and final writes are observable
	// in the ordering below.
	if err := store.lockMemoryBackend.DeleteObjects(ctx, []string{siteVersionsKey("sre")}); err != nil {
		t.Fatal(err)
	}

	// Seed a preview catalog whose only group has no manifest, so reconciliation
	// must rewrite _previews/sre/catalog.json during the retry.
	catalogBytes, err := preview.EncodeCatalog(preview.Catalog{
		SchemaVersion: preview.SchemaVersion, Site: "sre",
		Groups:          []preview.Group{previewRemoveTestGroup("pr:42", strings.Repeat("c", 40))},
		RevisionHistory: []preview.GroupRevisionHistory{ownership("pr:42", preview.RevisionOwnership{HeadSHA: strings.Repeat("c", 40), Files: []string{"guide.md"}})},
	})
	if err != nil {
		t.Fatal(err)
	}
	seedMemoryObject(store.lockMemoryBackend, previewCatalogKey, catalogBytes)

	// Run 2: retry resumes from schema 2 and converges.
	retry := &mutationLogBackend{sitePublishRecoveryBackend: newSitePublishRecoveryBackend(store), journalKey: journalKey}
	result, err := PublishSite(ctx, retry, options)
	if err != nil || result.Outcome != "synced" {
		t.Fatalf("retry = %+v, err=%v", result, err)
	}
	finalState, _, _ := sitePublishRecoveryReadState(t, store)
	if finalState.Committed.Generation != tx.ID {
		t.Fatalf("final generation = %q, want transaction %q", finalState.Committed.Generation, tx.ID)
	}
	if got := store.objectBytes("_artifacts/sre/report.html"); !strings.Contains(got, "Schema one transaction") {
		t.Fatalf("converged page = %q", got)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(ctx, journalKey); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("journal after retry = %v; want deleted", err)
	}
	for _, body := range retry.journalBodys {
		if strings.Contains(body, `"schemaVersion":1`) {
			t.Fatalf("retry wrote a schema 1 journal: %s", body)
		}
	}

	// The journal delete happens only after state commit, preview
	// reconciliation and the version record, and after all projection writes.
	retryEvents := retry.snapshotEvents()
	del := eventIndex(retryEvents, "delete:"+journalKey, true)
	state := eventIndex(retryEvents, "cond:"+sitePublishStateKey("sre"), true)
	version := eventIndex(retryEvents, "put:"+siteVersionsKey("sre"), true)
	if del < 0 || state < 0 || version < 0 {
		t.Fatalf("missing events: delete=%d state=%d version=%d in %v", del, state, version, retryEvents)
	}
	if !(state < version && version < del) {
		t.Fatalf("order state=%d version=%d journal delete=%d; want state < version < delete (%v)", state, version, del, retryEvents)
	}
	catalogWrite := eventIndex(retryEvents, "put:"+previewCatalogKey, true)
	if catalogWrite < 0 {
		catalogWrite = eventIndex(retryEvents, "cond:"+previewCatalogKey, true)
	}
	if catalogWrite < 0 {
		t.Fatalf("retry did not reconcile the preview catalog (%v)", retryEvents)
	}
	if !(state < catalogWrite && catalogWrite < del) {
		t.Fatalf("order state=%d preview catalog write=%d journal delete=%d; want state < catalog < delete (%v)", state, catalogWrite, del, retryEvents)
	}
	lastProjection := -1
	for i, e := range retryEvents {
		if _, key, _ := strings.Cut(e, ":"); sitePublishRecoveryProjectionKey(key) {
			lastProjection = i
		}
	}
	if lastProjection < 0 || lastProjection > state {
		t.Fatalf("last projection write %d after state commit %d (%v)", lastProjection, state, retryEvents)
	}
}

// registryLogBackend records mutating calls of a registry operation in order.
type registryLogBackend struct {
	*registryApplyTestBackend
	events []string
	bodies map[string]string
}

func (b *registryLogBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	etag, err := b.registryApplyTestBackend.PutObjectConditional(ctx, key, object, condition)
	if err == nil {
		b.events = append(b.events, "cond:"+key)
		b.bodies[key] = string(object.Bytes)
	}
	return etag, err
}

func (b *registryLogBackend) DeleteObjects(ctx context.Context, keys []string) error {
	err := b.registryApplyTestBackend.DeleteObjects(ctx, keys)
	if err == nil {
		for _, key := range keys {
			b.events = append(b.events, "delete:"+key)
		}
	}
	return err
}

func TestRegistrySyncMigratesSchema1CleanupBeforeDeletingOmittedSiteData(t *testing.T) {
	ctx := context.Background()
	inner := newRegistryApplyTestBackend()
	seedRegistryFromManifest(t, inner, manifestWithoutLegacy)
	inner.seed("_artifacts/legacy/report.html", []byte("legacy artifact"))
	inner.seed("_indexes/legacy/meta.json", []byte("{}"))
	paths := legacyRegistryCleanupRequiredPaths(true, []string{"legacy"})
	quoted := make([]string, len(paths))
	for i, p := range paths {
		quoted[i] = fmt.Sprintf("%q", p)
	}
	inner.seed(registryCleanupKey, []byte(`{"schemaVersion":1,"sites":["legacy"],"paths":[`+strings.Join(quoted, ",")+`]}`))
	backend := &registryLogBackend{registryApplyTestBackend: inner, bodies: map[string]string{}}

	result, err := RegisterSites(ctx, backend, testRegistryProjection(t, manifestWithoutLegacy), false)
	if err != nil || result.Outcome != "synced" {
		t.Fatalf("RegisterSites() = %+v, err=%v", result, err)
	}
	rewrite := eventIndex(backend.events, "cond:"+registryCleanupKey, false)
	clear := eventIndex(backend.events, "delete:"+registryCleanupKey, true)
	dataDelete := -1
	for i, e := range backend.events {
		if strings.HasPrefix(e, "delete:_artifacts/legacy/") || strings.HasPrefix(e, "delete:_indexes/legacy/") {
			dataDelete = i
			break
		}
	}
	if rewrite < 0 || dataDelete < 0 || clear < 0 {
		t.Fatalf("missing events: rewrite=%d data delete=%d clear=%d in %v", rewrite, dataDelete, clear, backend.events)
	}
	if !(rewrite < dataDelete && dataDelete < clear) {
		t.Fatalf("order rewrite=%d data delete=%d clear=%d; want rewrite < data delete < clear (%v)", rewrite, dataDelete, clear, backend.events)
	}
	if body := backend.bodies[registryCleanupKey]; !strings.Contains(body, `"schemaVersion":2`) || strings.Contains(body, `"paths"`) || !strings.Contains(body, `"legacy"`) {
		t.Fatalf("cleanup rewrite body = %s; want schema 2 naming legacy and no paths", body)
	}
	for _, key := range []string{"_artifacts/legacy/report.html", "_indexes/legacy/meta.json"} {
		if _, _, err := inner.GetObject(ctx, key); !errors.Is(err, ErrObjectNotFound) {
			t.Fatalf("%s after cleanup = %v; want deleted", key, err)
		}
	}
	if _, _, err := inner.GetObject(ctx, registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("cleanup record after sync = %v; want cleared", err)
	}
}
