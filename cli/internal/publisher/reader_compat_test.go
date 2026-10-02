package publisher

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tasuku43/git-artifact-pages/cli/internal/compat"
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

func TestControlRecordReadersIgnoreUnknownFieldsAndNameUnsupportedSchemas(t *testing.T) {
	root := t.TempDir()
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if _, err := decodeLockRecord([]byte(`{"schemaVersion":1,"site":"sre","state":"free","future":1}`), "sre"); err != nil {
		t.Errorf("lock record with an unknown field: %v", err)
	}
	if _, err := decodeLockRecord([]byte(`{"schemaVersion":2,"site":"sre","state":"free","owner":{"new":true}}`), "sre"); !compat.Is(err) || !strings.Contains(err.Error(), "site lock record") {
		t.Errorf("lock record v2 error = %v", err)
	}

	writeControlRecord(t, root, registryCleanupKey, `{"schemaVersion":1,"sites":["a"],"future":true}`)
	if _, _, err := readRegistryCleanup(ctx, backend); err != nil {
		t.Errorf("cleanup record with an unknown field: %v", err)
	}
	writeControlRecord(t, root, registryCleanupKey, `{"schemaVersion":2,"sites":"other"}`)
	if _, _, err := readRegistryCleanup(ctx, backend); !compat.Is(err) {
		t.Errorf("cleanup record v2 error = %v", err)
	}

	writeControlRecord(t, root, siteCacheRetryKey("sre"), `{"schemaVersion":1,"paths":["/_indexes/sre/index.json"],"future":true}`)
	if _, _, err := readSiteCacheRetry(ctx, backend, "sre"); err != nil {
		t.Errorf("cache retry record with an unknown field: %v", err)
	}
	writeControlRecord(t, root, siteCacheRetryKey("sre"), `{"schemaVersion":2,"paths":[]}`)
	if _, _, err := readSiteCacheRetry(ctx, backend, "sre"); !compat.Is(err) {
		t.Errorf("cache retry record v2 error = %v", err)
	}
}
