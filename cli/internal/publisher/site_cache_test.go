package publisher

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
)

func TestSiteCacheJournalSchema2RetainsOriginTransactionOnly(t *testing.T) {
	b := newLockMemoryBackend()
	tx := &sitePublishTransaction{ID: strings.Repeat("a", 64), BaseGeneration: strings.Repeat("b", 64), TouchedKeys: []string{"_artifacts/sre/a.html"}}
	if _, err := writeSiteCacheRetryRecord(context.Background(), b, "sre", siteCacheRetry{Transaction: tx}, ""); err != nil {
		t.Fatal(err)
	}
	object, _, err := getSiteControl(context.Background(), b, "sre", siteCacheRetryKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(object.Bytes), "paths") || !strings.Contains(string(object.Bytes), `"schemaVersion":2`) {
		t.Fatalf("journal = %s", object.Bytes)
	}
	got, _, err := readSiteCacheRetry(context.Background(), b, "sre")
	if err != nil || got.Transaction == nil || got.Transaction.ID != tx.ID {
		t.Fatalf("read journal = %+v, %v", got, err)
	}
}

func TestSiteCacheJournalValidatesAndMigratesLegacySchema1(t *testing.T) {
	b := newLockMemoryBackend()
	tx := sitePublishTransaction{ID: strings.Repeat("c", 64), BaseGeneration: strings.Repeat("d", 64), TouchedKeys: []string{"_artifacts/sre/a.html"}}
	legacy := `{"schemaVersion":1,"site":"sre","paths":["/_artifacts/sre/a.html"],"transaction":{"id":"` + tx.ID + `","baseGeneration":"` + tx.BaseGeneration + `","touchedKeys":["_artifacts/sre/a.html"]}}`
	seedMemoryObject(b, siteCacheRetryKey("sre"), []byte(legacy))
	record, etag, err := readSiteCacheRetry(context.Background(), b, "sre")
	if err != nil || !record.legacyRecord || record.Transaction == nil || record.Transaction.ID != tx.ID || etag == "" {
		t.Fatalf("legacy read = %+v etag=%q err=%v", record, etag, err)
	}
	migratedETag, err := writeSiteCacheRetryRecord(context.Background(), b, "sre", siteCacheRetry{Transaction: record.Transaction}, etag)
	if err != nil || migratedETag == etag {
		t.Fatalf("CAS migration ETag = %q, err=%v", migratedETag, err)
	}
	object, _, err := b.GetObject(context.Background(), siteCacheRetryKey("sre"))
	if err != nil || strings.Contains(string(object.Bytes), "paths") || !strings.Contains(string(object.Bytes), `"schemaVersion":2`) {
		t.Fatalf("migrated journal = %s err=%v", object.Bytes, err)
	}
}

func TestSiteCacheJournalFailsClosedOnUnknownFieldsAndUnsupportedSchema(t *testing.T) {
	for _, test := range []struct {
		name, raw string
		compat    bool
	}{
		{name: "schema 2 invalid transaction", raw: `{"schemaVersion":2,"site":"sre","transaction":{}}`},
		{name: "schema 1 unknown field", raw: `{"schemaVersion":1,"site":"sre","paths":["/_artifacts/sre/a.html"],"future":true}`},
		{name: "unsupported schema", raw: `{"schemaVersion":9,"site":"sre","transaction":{},"future":true}`, compat: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			b := newLockMemoryBackend()
			seedMemoryObject(b, siteCacheRetryKey("sre"), []byte(test.raw))
			_, _, err := readSiteCacheRetry(context.Background(), b, "sre")
			if err == nil {
				t.Fatalf("read accepted unsupported journal %s", test.raw)
			}
			if compat.Is(err) != test.compat {
				t.Fatalf("compat.Is(%v) = %v, want %v", err, compat.Is(err), test.compat)
			}
		})
	}
}

func TestPublishSiteDryRunOverSchema1SiteJournalWritesNothing(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	committed, _, _ := sitePublishRecoveryReadState(t, store)
	sitePublishRecoveryChangePage(t, root, "<title>Dry run</title><h1>Legacy journal dry run</h1>")
	tx := sitePublishTransaction{ID: strings.Repeat("e", 64), BaseGeneration: committed.Committed.Generation, TouchedKeys: []string{"_artifacts/sre/report.html"}}
	legacy := `{"schemaVersion":1,"site":"sre","paths":["/_artifacts/sre/report.html"],"transaction":{"id":"` + tx.ID + `","baseGeneration":"` + tx.BaseGeneration + `","touchedKeys":["_artifacts/sre/report.html"]}}`
	seedMemoryObject(store.lockMemoryBackend, siteCacheRetryKey("sre"), []byte(legacy))
	beforeObjects, beforeETags := snapshotLockMemory(store.lockMemoryBackend)
	options.DryRun = true
	result, err := PublishSite(context.Background(), newSitePublishRecoveryBackend(store), options)
	if err != nil || result.Outcome != "planned" {
		t.Fatalf("dry-run over schema 1 journal = %+v, err=%v; want planned", result, err)
	}
	afterObjects, afterETags := snapshotLockMemory(store.lockMemoryBackend)
	if !reflect.DeepEqual(beforeObjects, afterObjects) || !reflect.DeepEqual(beforeETags, afterETags) {
		t.Fatal("dry-run over a schema 1 site journal wrote or removed objects")
	}
}

func snapshotLockMemory(backend *lockMemoryBackend) (map[string]Object, map[string]string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	objects := make(map[string]Object, len(backend.objects))
	for key, object := range backend.objects {
		object.Bytes = append([]byte(nil), object.Bytes...)
		objects[key] = object
	}
	etags := make(map[string]string, len(backend.etags))
	for key, etag := range backend.etags {
		etags[key] = etag
	}
	return objects, etags
}
