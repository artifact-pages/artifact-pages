package publisher

import (
	"context"
	"strings"
	"testing"
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
	for _, raw := range []string{
		`{"schemaVersion":2,"site":"sre","transaction":{}}`,
		`{"schemaVersion":9,"site":"sre","transaction":{},"future":true}`,
	} {
		b := newLockMemoryBackend()
		seedMemoryObject(b, siteCacheRetryKey("sre"), []byte(raw))
		if _, _, err := readSiteCacheRetry(context.Background(), b, "sre"); err == nil {
			t.Fatalf("read accepted unsupported journal %s", raw)
		}
	}
}
