package publisher

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
)

type appCacheRetryTestBackend struct {
	getObject Object
	getETag   string
	getErr    error
	getKey    string
	getCalls  int

	putKey       string
	putObject    Object
	putCondition ObjectCondition
	putETag      string
	putErr       error
	putCalls     int

	deletedKeys []string
	deleteErr   error
}

func (backend *appCacheRetryTestBackend) PutObject(context.Context, string, Object) error {
	return nil
}

func (backend *appCacheRetryTestBackend) ListKeys(context.Context, string) ([]string, error) {
	return nil, nil
}

func (backend *appCacheRetryTestBackend) DeleteObjects(_ context.Context, keys []string) error {
	backend.deletedKeys = append([]string(nil), keys...)
	return backend.deleteErr
}

func (backend *appCacheRetryTestBackend) Invalidate(context.Context, []string) (string, error) {
	return "", nil
}

func (backend *appCacheRetryTestBackend) GetObject(_ context.Context, key string) (Object, string, error) {
	backend.getCalls++
	backend.getKey = key
	return backend.getObject, backend.getETag, backend.getErr
}

func (backend *appCacheRetryTestBackend) HeadObject(context.Context, string) (ObjectInfo, error) {
	return ObjectInfo{}, nil
}

func (backend *appCacheRetryTestBackend) PutObjectConditional(_ context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.putCalls++
	backend.putKey = key
	backend.putObject = object
	backend.putCondition = condition
	return backend.putETag, backend.putErr
}

func TestReadAppCacheRetryAbsentAndValid(t *testing.T) {
	t.Run("absent", func(t *testing.T) {
		backend := &appCacheRetryTestBackend{getErr: ErrObjectNotFound}
		record, etag, err := readAppCacheRetry(context.Background(), backend)
		if err != nil {
			t.Fatalf("readAppCacheRetry() error = %v", err)
		}
		if record.SchemaVersion != appCacheRetrySchema || record.Paths == nil || len(record.Paths) != 0 || etag != "" {
			t.Fatalf("readAppCacheRetry() = %#v, %q; want schema %d, empty non-nil paths, and no ETag", record, etag, appCacheRetrySchema)
		}
		if backend.getKey != appCacheRetryObjectKey || backend.putCalls != 0 {
			t.Fatalf("read key = %q, writes = %d; want key %q and no writes", backend.getKey, backend.putCalls, appCacheRetryObjectKey)
		}
	})

	t.Run("unknown field fails closed", func(t *testing.T) {
		backend := &appCacheRetryTestBackend{
			getObject: Object{Bytes: []byte(`{"schemaVersion":1,"paths":["/index.html"],"futureField":{"enabled":true}}`)},
			getETag:   `"current-etag"`,
		}
		record, etag, err := readAppCacheRetry(context.Background(), backend)
		if err == nil {
			t.Fatalf("readAppCacheRetry() = %#v, %q; want unknown field rejection", record, etag)
		}
		if backend.getKey != appCacheRetryObjectKey || backend.putCalls != 0 {
			t.Fatalf("read key = %q, writes = %d; want key %q and no writes", backend.getKey, backend.putCalls, appCacheRetryObjectKey)
		}
	})
}

func TestReadAppCacheRetryUnsupportedSchemaCheckedBeforeFields(t *testing.T) {
	b := &appCacheRetryTestBackend{getObject: Object{Bytes: []byte(`{"schemaVersion":3,"paths":7,"newShape":true}`)}, getETag: "etag"}
	_, _, err := readAppCacheRetry(context.Background(), b)
	if !compat.Is(err) || !strings.Contains(err.Error(), "app cache retry record") || !strings.Contains(err.Error(), "3") {
		t.Fatalf("unsupported app schema err=%v", err)
	}
}

func TestReadAppCacheRetryRejectsInvalidRecordsWithoutWriting(t *testing.T) {
	oversized := fmt.Sprintf(`{"schemaVersion":1,"paths":["/index.html"],"padding":"%s"}`, strings.Repeat("x", maxAppCacheRetryBytes))
	tests := []struct {
		name    string
		bytes   []byte
		etag    string
		readErr error
	}{
		{name: "missing schema", bytes: []byte(`{"paths":["/index.html"]}`), etag: `"etag"`},
		{name: "wrong schema field casing", bytes: []byte(`{"SchemaVersion":1,"paths":["/index.html"]}`), etag: `"etag"`},
		{name: "invalid schema type", bytes: []byte(`{"schemaVersion":"1","paths":["/index.html"]}`), etag: `"etag"`},
		{name: "wrong schema", bytes: []byte(`{"schemaVersion":2,"paths":["/index.html"]}`), etag: `"etag"`},
		{name: "non-object JSON", bytes: []byte(`[1]`), etag: `"etag"`},
		{name: "missing paths", bytes: []byte(`{"schemaVersion":1}`), etag: `"etag"`},
		{name: "null paths", bytes: []byte(`{"schemaVersion":1,"paths":null}`), etag: `"etag"`},
		{name: "empty paths", bytes: []byte(`{"schemaVersion":1,"paths":[]}`), etag: `"etag"`},
		{name: "empty path", bytes: []byte(`{"schemaVersion":1,"paths":[""]}`), etag: `"etag"`},
		{name: "unsupported path", bytes: []byte(`{"schemaVersion":1,"paths":["/other.html"]}`), etag: `"etag"`},
		{name: "duplicate path", bytes: []byte(`{"schemaVersion":1,"paths":["/index.html","/index.html"]}`), etag: `"etag"`},
		{name: "malformed JSON", bytes: []byte(`{"schemaVersion":1,"paths":[`), etag: `"etag"`},
		{name: "trailing JSON", bytes: []byte(`{"schemaVersion":1,"paths":["/index.html"]} {}`), etag: `"etag"`},
		{name: "duplicate known key", bytes: []byte(`{"schemaVersion":1,"schemaVersion":1,"paths":["/index.html"]}`), etag: `"etag"`},
		{name: "duplicate additive key", bytes: []byte(`{"schemaVersion":1,"paths":["/index.html"],"future":{"x":1,"x":2}}`), etag: `"etag"`},
		{name: "oversized", bytes: []byte(oversized), etag: `"etag"`},
		{name: "blank ETag", bytes: []byte(`{"schemaVersion":1,"paths":["/index.html"]}`), etag: " \t"},
		{name: "read error", readErr: errors.New("backend unavailable")},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := &appCacheRetryTestBackend{
				getObject: Object{Bytes: test.bytes},
				getETag:   test.etag,
				getErr:    test.readErr,
			}
			if _, _, err := readAppCacheRetry(context.Background(), backend); err == nil {
				t.Fatal("readAppCacheRetry() error = nil, want failure")
			}
			if backend.getKey != appCacheRetryObjectKey || backend.putCalls != 0 {
				t.Fatalf("read key = %q, writes = %d; want key %q and no writes", backend.getKey, backend.putCalls, appCacheRetryObjectKey)
			}
		})
	}
}

func TestClearAppCacheRetryDeletesOnlyJournalKey(t *testing.T) {
	backend := &appCacheRetryTestBackend{}
	if err := clearAppCacheRetry(context.Background(), backend); err != nil {
		t.Fatalf("clearAppCacheRetry() error = %v", err)
	}
	if len(backend.deletedKeys) != 1 || backend.deletedKeys[0] != appCacheRetryObjectKey {
		t.Fatalf("deleted keys = %#v; want only %q", backend.deletedKeys, appCacheRetryObjectKey)
	}
}
