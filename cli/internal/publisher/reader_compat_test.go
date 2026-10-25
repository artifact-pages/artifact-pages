package publisher

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
)

func writeControlRecord(t *testing.T, root, key, body string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestControlRecordReadersApplyLegacyAndCurrentSchemaPolicies(t *testing.T) {
	ctx := context.Background()
	b := newLockMemoryBackend()
	lock1 := []byte(`{"schemaVersion":1,"site":"sre","state":"free","future":1}`)
	if _, err := decodeLockRecord(lock1, "sre"); err != nil {
		t.Fatalf("lock v1 unknown: %v", err)
	}
	if _, err := decodeLockRecord([]byte(`{"schemaVersion":2,"site":"sre","state":"free","owner":{"new":true}}`), "sre"); !compat.Is(err) {
		t.Fatalf("lock v2 = %v", err)
	}
	tx := `"transaction":{"id":"` + strings.Repeat("a", 64) + `","baseGeneration":"` + strings.Repeat("b", 64) + `","touchedKeys":["_artifacts/sre/a.html"]}`
	for _, tc := range []struct {
		name, raw string
		accept    bool
	}{{"v1", `{"schemaVersion":1,"site":"sre","paths":["/_artifacts/sre/a.html"],` + tx + `}`, true}, {"v1 unknown", `{"schemaVersion":1,"site":"sre","paths":["/_artifacts/sre/a.html"],` + tx + `,"future":true}`, false}, {"v2 unknown", `{"schemaVersion":2,"site":"sre",` + tx + `,"future":true}`, true}, {"v3 incompatible body", `{"schemaVersion":3,"site":false,"transaction":7}`, false}, {"malformed v2", `{"schemaVersion":2,"site":"sre","transaction":{}}`, false}} {
		seedMemoryObject(b, siteCacheRetryKey("sre"), []byte(tc.raw))
		_, _, err := readSiteCacheRetry(ctx, b, "sre")
		if (err == nil) != tc.accept || (strings.Contains(tc.name, "v3") && !compat.Is(err)) || (strings.Contains(tc.name, "malformed") && compat.Is(err)) {
			t.Errorf("site %s err=%v", tc.name, err)
		}
	}
	siteV1 := `{"schemaVersion":1,"sites":["a"],"paths":["/_artifacts/a/*","/_indexes/a/*","/_indexes/sites.json","/_previews/a/*","/a","/a/*"]}`
	siteV1Unknown := strings.TrimSuffix(siteV1, "}") + `,"future":true}`
	for _, tc := range []struct {
		name, raw string
		accept    bool
	}{{"v1", siteV1, true}, {"v1 unknown", siteV1Unknown, false}, {"v2 unknown", `{"schemaVersion":2,"sites":[],"future":true}`, true}, {"v3 incompatible body", `{"schemaVersion":3,"sites":"wrong","paths":7}`, false}, {"bad v2", `{"schemaVersion":2,"sites":"wrong"}`, false}} {
		seedMemoryObject(b, registryCleanupKey, []byte(tc.raw))
		_, _, err := readRegistryCleanup(ctx, b)
		if (err == nil) != tc.accept || (strings.Contains(tc.name, "v3") && !compat.Is(err)) || (tc.name == "bad v2" && compat.Is(err)) {
			t.Errorf("registry %s err=%v", tc.name, err)
		}
	}
	preview1 := `{"schemaVersion":1,"site":"sre","groupId":"pr:42","revisions":[],"objectKeys":[],"paths":["/_previews/sre/*"]}`
	preview1Unknown := strings.TrimSuffix(preview1, "}") + `,"future":true}`
	for _, tc := range []struct {
		name, raw string
		accept    bool
	}{{"v1", preview1, true}, {"v1 unknown", preview1Unknown, false}, {"v2 unknown", `{"schemaVersion":2,"site":"sre","groupId":"pr:42","revisions":[],"objectKeys":[],"future":true}`, true}, {"v3 incompatible body", `{"schemaVersion":3,"site":2}`, false}, {"malformed v2", `{"schemaVersion":2,"site":"sre","groupId":"pr:42","revisions":null,"objectKeys":[]}`, false}} {
		seedMemoryObject(b, previewCleanupKey("sre"), []byte(tc.raw))
		_, _, err := readPreviewCleanup(ctx, b, "sre")
		if (err == nil) != tc.accept || (strings.Contains(tc.name, "v3") && !compat.Is(err)) || (strings.Contains(tc.name, "malformed") && compat.Is(err)) {
			t.Errorf("preview %s err=%v", tc.name, err)
		}
	}
}
