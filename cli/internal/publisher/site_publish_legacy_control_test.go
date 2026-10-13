package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

type sitePublishLegacyCaptureBackend struct {
	*sitePublishScaleBackend
	mu              sync.Mutex
	stateConditions []ObjectCondition
	retryConditions []ObjectCondition
	originWrites    []string
	originDeletes   []string
	invalidations   [][]string
	raceStateOnPut  bool
	racedState      bool
}

func (backend *sitePublishLegacyCaptureBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.mu.Lock()
	if key == sitePublishStateKey("sre") {
		backend.stateConditions = append(backend.stateConditions, condition)
	}
	if key == siteCacheRetryKey("sre") {
		backend.retryConditions = append(backend.retryConditions, condition)
	}
	backend.mu.Unlock()
	return backend.sitePublishScaleBackend.PutObjectConditional(ctx, key, object, condition)
}

func (backend *sitePublishLegacyCaptureBackend) PutObject(ctx context.Context, key string, object Object) error {
	if sitePublishLegacyProjectionKey(key) {
		backend.mu.Lock()
		backend.originWrites = append(backend.originWrites, key)
		backend.mu.Unlock()
	}
	if err := backend.sitePublishScaleBackend.PutObject(ctx, key, object); err != nil {
		return err
	}
	backend.mu.Lock()
	injectRace := backend.raceStateOnPut && !backend.racedState && sitePublishLegacyProjectionKey(key)
	if injectRace {
		backend.racedState = true
	}
	backend.mu.Unlock()
	if injectRace {
		stateKey := sitePublishStateKey("sre")
		_, etag, err := backend.sitePublishScaleBackend.GetObject(ctx, stateKey)
		if err != nil {
			return err
		}
		_, err = backend.sitePublishScaleBackend.PutObjectConditional(ctx, stateKey, Object{Bytes: []byte("concurrent writer")}, ObjectCondition{IfMatchETag: etag})
		if err != nil {
			return err
		}
	}
	return nil
}

func (backend *sitePublishLegacyCaptureBackend) DeleteObjects(ctx context.Context, keys []string) error {
	for _, key := range keys {
		if sitePublishLegacyProjectionKey(key) {
			backend.mu.Lock()
			backend.originDeletes = append(backend.originDeletes, key)
			backend.mu.Unlock()
		}
	}
	return backend.sitePublishScaleBackend.DeleteObjects(ctx, keys)
}

func (backend *sitePublishLegacyCaptureBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	backend.mu.Lock()
	backend.invalidations = append(backend.invalidations, append([]string(nil), paths...))
	backend.mu.Unlock()
	return backend.sitePublishScaleBackend.Invalidate(ctx, paths)
}

func sitePublishLegacyProjectionKey(key string) bool {
	return strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/")
}

func legacySitePublishState(t *testing.T, store *sitePublishScaleBackend, shape string) (Object, string) {
	t.Helper()
	key := sitePublishStateKey("sre")
	object, etag, err := store.lockMemoryBackend.GetObject(context.Background(), key)
	if err != nil {
		t.Fatalf("read current site publish state: %v", err)
	}
	legacy := cloneSiteControlObject(object)
	switch shape {
	case "missing committed input root":
		delete(legacy.Metadata, "artifact-pages-publish-input-root")
	case "missing committed generation":
		delete(legacy.Metadata, "artifact-pages-publish-generation")
	case "obsolete inline pending field", "body missing committed generation":
		plain, err := decompressSitePublishState(legacy.Bytes)
		if err != nil {
			t.Fatalf("decompress current state: %v", err)
		}
		var envelope map[string]json.RawMessage
		if err := json.Unmarshal(plain, &envelope); err != nil {
			t.Fatalf("decode current state: %v", err)
		}
		if shape == "obsolete inline pending field" {
			envelope["pending"] = json.RawMessage("true")
		} else {
			var committed map[string]json.RawMessage
			if err := json.Unmarshal(envelope["committed"], &committed); err != nil {
				t.Fatalf("decode committed state: %v", err)
			}
			delete(committed, "generation")
			envelope["committed"], err = json.Marshal(committed)
			if err != nil {
				t.Fatalf("encode legacy committed state: %v", err)
			}
		}
		plain, err = json.Marshal(envelope)
		if err != nil {
			t.Fatalf("encode legacy state: %v", err)
		}
		legacy.Bytes = gzipForTest(t, plain)
		legacy.Metadata["artifact-pages-sha256"] = sha256Hex(legacy.Bytes)
	default:
		t.Fatalf("unknown legacy state shape %q", shape)
	}
	legacyETag, err := store.lockMemoryBackend.PutObjectConditional(context.Background(), key, legacy, ObjectCondition{IfMatchETag: etag})
	if err != nil {
		t.Fatalf("seed legacy state: %v", err)
	}
	return legacy, legacyETag
}

func addLegacyPublishChanges(t *testing.T, root string, store *sitePublishScaleBackend) (staleKey, newKey string) {
	t.Helper()
	oldArtifact, _, err := store.lockMemoryBackend.GetObject(context.Background(), "_artifacts/sre/report.html")
	if err != nil {
		t.Fatalf("read existing artifact for stale fixture: %v", err)
	}
	staleKey, newKey = "_artifacts/sre/stale.html", "_artifacts/sre/new.html"
	if err := store.lockMemoryBackend.PutObject(context.Background(), staleKey, cloneSiteControlObject(oldArtifact)); err != nil {
		t.Fatalf("seed stale artifact: %v", err)
	}
	newSource := filepath.Join(root, "docs", "artifacts", "new.html")
	if err := os.WriteFile(newSource, []byte("<title>New</title><h1>New artifact</h1>"), 0o600); err != nil {
		t.Fatalf("create new source artifact: %v", err)
	}
	return staleKey, newKey
}

func publishSiteLegacyCapture(t *testing.T, root string, store *sitePublishScaleBackend, options SitePublishOptions, backend DeploymentBackend) (Result, error) {
	t.Helper()
	if backend == nil {
		backend = &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
	}
	options.SourceDir = filepath.Join(root, "docs", "artifacts")
	return PublishSite(context.Background(), backend, options)
}

func TestPublishSiteRebuildsKnownLegacyPublishStateShapes(t *testing.T) {
	for _, shape := range []string{
		"missing committed input root",
		"missing committed generation",
		"body missing committed generation",
		"obsolete inline pending field",
	} {
		t.Run(shape, func(t *testing.T) {
			root, store, options := sitePublishRecoveryFixture(t)
			legacyObject, legacyETag := legacySitePublishState(t, store, shape)
			staleKey, newKey := addLegacyPublishChanges(t, root, store)
			backend := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
			result, err := publishSiteLegacyCapture(t, root, store, options, backend)
			if err != nil || result.Outcome != "synced" {
				t.Fatalf("legacy publish = %+v, %v", result, err)
			}
			if result.LegacyControl == nil || result.LegacyControl.PublishState == nil || result.LegacyControl.PublishState.Detail == "" {
				t.Fatalf("legacy publish result omitted details: %+v", result.LegacyControl)
			}
			backupKey := siteLegacyPublishStateBackupKey("sre", legacyObject.Bytes)
			if result.LegacyControl.PublishState.BackupKey != backupKey {
				t.Fatalf("backup key = %q, want %q", result.LegacyControl.PublishState.BackupKey, backupKey)
			}
			backup, _, err := store.lockMemoryBackend.GetObject(context.Background(), backupKey)
			if err != nil || !reflect.DeepEqual(backup, legacyObject) {
				t.Fatalf("legacy backup = %+v, %v; want exact original object %+v", backup, err, legacyObject)
			}
			if len(backend.stateConditions) != 1 || backend.stateConditions[0] != (ObjectCondition{IfMatchETag: legacyETag}) {
				t.Fatalf("state write conditions = %#v; want If-Match %q", backend.stateConditions, legacyETag)
			}
			if !sitePublishHasChange(result.Changes, "remove", staleKey) || !sitePublishHasChange(result.Changes, "create", newKey) {
				t.Fatalf("legacy inventory diff = %+v; want stale removal and new upload", result.Changes)
			}
			if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), staleKey); !errors.Is(err, ErrObjectNotFound) {
				t.Fatalf("stale managed object remains: %v", err)
			}
			if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), newKey); err != nil {
				t.Fatalf("new managed object was not uploaded: %v", err)
			}
			state, _, _ := sitePublishRecoveryReadState(t, store)
			if state.SchemaVersion != 1 || state.Committed.Generation == "" {
				t.Fatalf("rebuilt state = %+v", state)
			}
		})
	}
}

type sitePublishLegacyGetOnlyBackend struct {
	*sitePublishLegacyCaptureBackend
}

type sitePublishLegacyHeadSizeMismatchBackend struct {
	*sitePublishLegacyCaptureBackend
}

func (backend *sitePublishLegacyHeadSizeMismatchBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	info, err := backend.sitePublishLegacyCaptureBackend.HeadObject(ctx, key)
	if err == nil && key == sitePublishStateKey("sre") {
		info.Size++
	}
	return info, err
}

func (*sitePublishLegacyGetOnlyBackend) publishStateReadMode() publishStateReadMode {
	return publishStateReadGetOnly
}

func TestPublishSiteRebuildsLegacyStateInGetOnlyMode(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	legacy, _ := legacySitePublishState(t, store, "missing committed generation")
	addLegacyPublishChanges(t, root, store)
	base := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
	backend := &sitePublishLegacyGetOnlyBackend{sitePublishLegacyCaptureBackend: base}
	options.SourceDir = filepath.Join(root, "docs", "artifacts")
	result, err := PublishSite(context.Background(), backend, options)
	if err != nil || result.LegacyControl == nil || result.LegacyControl.PublishState == nil {
		t.Fatalf("GET-only legacy publish = %+v, %v", result, err)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteLegacyPublishStateBackupKey("sre", legacy.Bytes)); err != nil {
		t.Fatalf("GET-only legacy backup missing: %v", err)
	}
}

func TestPublishSiteLegacyValidationFailsClosedBeforeWrites(t *testing.T) {
	for _, test := range []struct {
		name             string
		edit             func(*Object)
		want             string
		headSizeMismatch bool
	}{
		{
			name: "invalid sha metadata",
			edit: func(object *Object) { object.Metadata["artifact-pages-sha256"] = "not-a-hash" },
			want: "site publish state HEAD has an invalid compressed SHA256",
		},
		{
			name:             "size mismatch",
			want:             "site publish state body size does not match HEAD",
			headSizeMismatch: true,
		},
		{
			name: "digest mismatch",
			edit: func(object *Object) {
				object.Metadata["artifact-pages-sha256"] = strings.Repeat("0", 64)
				if object.Metadata["artifact-pages-sha256"] == sha256Hex(object.Bytes) {
					object.Metadata["artifact-pages-sha256"] = strings.Repeat("1", 64)
				}
			},
			want: "site publish state body SHA256 does not match HEAD",
		},
		{
			name: "non-gzip body",
			edit: func(object *Object) {
				object.Bytes = []byte("not gzip")
				object.Metadata["artifact-pages-sha256"] = sha256Hex(object.Bytes)
			},
			want: "open site publish state gzip:",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			root, store, options := sitePublishRecoveryFixture(t)
			legacy, etag := legacySitePublishState(t, store, "missing committed generation")
			if test.edit != nil {
				test.edit(&legacy)
				if _, err := store.lockMemoryBackend.PutObjectConditional(context.Background(), sitePublishStateKey("sre"), legacy, ObjectCondition{IfMatchETag: etag}); err != nil {
					t.Fatalf("seed malformed legacy state: %v", err)
				}
			}
			options.DryRun = true
			base := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
			var backend DeploymentBackend = base
			if test.headSizeMismatch {
				backend = &sitePublishLegacyHeadSizeMismatchBackend{sitePublishLegacyCaptureBackend: base}
			}
			store.resetCounts()
			_, err := publishSiteLegacyCapture(t, root, store, options, backend)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("legacy validation error = %v; want text containing %q", err, test.want)
			}
			counts, _, _, bytesWritten := store.countSnapshot()
			if counts["PUT"] != 0 || counts["DELETE"] != 0 || bytesWritten != 0 || len(base.originWrites) != 0 || len(base.originDeletes) != 0 || len(base.stateConditions) != 0 {
				t.Fatalf("invalid legacy state caused writes: counts=%v bytesWritten=%d origin=%v deletes=%v state=%v", counts, bytesWritten, base.originWrites, base.originDeletes, base.stateConditions)
			}
		})
	}
}

func TestPublishSiteLegacyDryRunIsReadOnlyAndReportsJSON(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	legacy, _ := legacySitePublishState(t, store, "missing committed generation")
	addLegacyPublishChanges(t, root, store)
	store.resetCounts()
	options.SourceDir = filepath.Join(root, "docs", "artifacts")
	options.DryRun = true
	result, err := PublishSite(context.Background(), store, options)
	if err != nil || result.LegacyControl == nil || result.LegacyControl.PublishState == nil {
		t.Fatalf("legacy dry run = %+v, %v", result, err)
	}
	counts, _, _, bytesWritten := store.countSnapshot()
	if counts["PUT"] != 0 || counts["DELETE"] != 0 || bytesWritten != 0 {
		t.Fatalf("legacy dry run wrote objects: counts=%v bytesWritten=%d", counts, bytesWritten)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	legacyJSON, ok := decoded["legacyControl"].(map[string]any)
	if !ok || legacyJSON["publishState"] == nil {
		t.Fatalf("JSON result omitted legacyControl.publishState: %s", encoded)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteLegacyPublishStateBackupKey("sre", legacy.Bytes)); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("dry run wrote legacy backup: %v", err)
	}
}

func TestPublishSiteLegacyStateCASRejectsConcurrentWriter(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	_, legacyETag := legacySitePublishState(t, store, "missing committed generation")
	addLegacyPublishChanges(t, root, store)
	backend := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store, raceStateOnPut: true}
	_, err := publishSiteLegacyCapture(t, root, store, options, backend)
	if err == nil || !strings.Contains(err.Error(), "commit site publish state after origin projection") || !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("concurrent legacy-state commit error = %v; want existing CAS failure", err)
	}
	if len(backend.stateConditions) != 1 || backend.stateConditions[0] != (ObjectCondition{IfMatchETag: legacyETag}) {
		t.Fatalf("state conditions = %#v; want If-Match %q", backend.stateConditions, legacyETag)
	}
	state, _, err := store.lockMemoryBackend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil || string(state.Bytes) != "concurrent writer" {
		t.Fatalf("state after failed CAS = %q, %v; want concurrent writer bytes", state.Bytes, err)
	}
}

func TestPublishSiteLegacyBackupConflictStopsBeforeOriginWrites(t *testing.T) {
	for _, existing := range []string{"identical", "different"} {
		t.Run(existing, func(t *testing.T) {
			root, store, options := sitePublishRecoveryFixture(t)
			legacy, _ := legacySitePublishState(t, store, "missing committed generation")
			addLegacyPublishChanges(t, root, store)
			backupKey := siteLegacyPublishStateBackupKey("sre", legacy.Bytes)
			bytes := legacy.Bytes
			if existing == "different" {
				bytes = []byte("different backup bytes")
			}
			if err := store.lockMemoryBackend.PutObject(context.Background(), backupKey, Object{Bytes: bytes}); err != nil {
				t.Fatal(err)
			}
			backend := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
			result, err := publishSiteLegacyCapture(t, root, store, options, backend)
			if existing == "identical" {
				if err != nil || result.Outcome != "synced" {
					t.Fatalf("publish with identical existing backup = %+v, %v", result, err)
				}
				return
			}
			if err == nil || err.Error() != "legacy publish-state backup "+backupKey+" exists with different bytes" {
				t.Fatalf("different backup error = %v", err)
			}
			if len(backend.originWrites) != 0 || len(backend.originDeletes) != 0 || len(backend.stateConditions) != 0 {
				t.Fatalf("origin/state writes occurred before backup conflict: writes=%v deletes=%v state=%v", backend.originWrites, backend.originDeletes, backend.stateConditions)
			}
		})
	}
}

func TestPublishSiteLegacyCacheRetryBackupConflictNamesRecord(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	legacyBytes := []byte(`{"schemaVersion":1,"paths":["/_artifacts/sre/old.html"]}`)
	legacy := Object{Bytes: legacyBytes, ContentType: "application/json; charset=utf-8", Cache: "no-store"}
	if _, err := store.lockMemoryBackend.PutObjectConditional(context.Background(), siteCacheRetryKey("sre"), legacy, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatalf("seed legacy cache retry record: %v", err)
	}
	backupKey := siteLegacyCacheRetryBackupKey("sre", legacyBytes)
	if err := store.lockMemoryBackend.PutObject(context.Background(), backupKey, Object{Bytes: []byte("different backup bytes")}); err != nil {
		t.Fatalf("seed conflicting cache retry backup: %v", err)
	}
	backend := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
	_, err := publishSiteLegacyCapture(t, root, store, options, backend)
	want := "legacy cache-retry record backup " + backupKey + " exists with different bytes"
	if err == nil || err.Error() != want {
		t.Fatalf("cache retry backup conflict = %v; want %q", err, want)
	}
	if len(backend.originWrites) != 0 || len(backend.originDeletes) != 0 || len(backend.stateConditions) != 0 || len(backend.retryConditions) != 0 {
		t.Fatalf("origin/control writes occurred before cache retry backup conflict: writes=%v deletes=%v state=%v retry=%v", backend.originWrites, backend.originDeletes, backend.stateConditions, backend.retryConditions)
	}
}

func TestPublishSiteLegacyStateWithRetryTransactionStops(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	legacy, _ := legacySitePublishState(t, store, "missing committed generation")
	transaction := sitePublishTransaction{
		ID:             "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		BaseGeneration: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		TouchedKeys:    []string{"_artifacts/sre/report.html"},
	}
	if _, err := writeSiteCacheRetryRecord(context.Background(), store.lockMemoryBackend, "sre", siteCacheRetry{Paths: []string{"/_artifacts/sre/report.html"}, Transaction: &transaction}, ""); err != nil {
		t.Fatal(err)
	}
	backend := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
	_, err := publishSiteLegacyCapture(t, root, store, options, backend)
	want := "site \"sre\" publish-state uses an older prerelease control format (missing committed generation) and has an unfinished cache retry; rerun with the CLI version that wrote it to finish the retry, or remove " + siteCacheRetryKey("sre") + " after confirming no publish is running"
	if err == nil || err.Error() != want {
		t.Fatalf("unfinished retry error = %v; want %q", err, want)
	}
	if len(backend.originWrites) != 0 || len(backend.originDeletes) != 0 || len(backend.stateConditions) != 0 {
		t.Fatalf("unfinished retry wrote origin/state: writes=%v deletes=%v state=%v", backend.originWrites, backend.originDeletes, backend.stateConditions)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteLegacyPublishStateBackupKey("sre", legacy.Bytes)); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("unfinished retry wrote a legacy state backup: %v", err)
	}
}

func TestPublishSiteAdoptsLegacyCacheRetryAndUsesItsETag(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	legacyBytes := []byte(`{"schemaVersion":1,"paths":["/_artifacts/sre/old.html"]}`)
	legacyObject := Object{Bytes: legacyBytes, ContentType: "application/json; charset=utf-8", Cache: "no-store", Metadata: map[string]string{"provider": "legacy"}}
	legacyETag, err := store.lockMemoryBackend.PutObjectConditional(context.Background(), siteCacheRetryKey("sre"), legacyObject, ObjectCondition{IfNoneMatch: true})
	if err != nil {
		t.Fatal(err)
	}
	backend := &sitePublishLegacyCaptureBackend{sitePublishScaleBackend: store}
	result, err := publishSiteLegacyCapture(t, root, store, options, backend)
	if err != nil || result.Outcome != "synced" || result.LegacyControl == nil || result.LegacyControl.CacheRetry == nil {
		t.Fatalf("legacy cache retry publish = %+v, %v", result, err)
	}
	backupKey := siteLegacyCacheRetryBackupKey("sre", legacyBytes)
	backup, _, err := store.lockMemoryBackend.GetObject(context.Background(), backupKey)
	if err != nil || !reflect.DeepEqual(backup, legacyObject) {
		t.Fatalf("cache retry backup = %+v, %v; want exact original object %+v", backup, err, legacyObject)
	}
	if len(backend.retryConditions) != 1 || backend.retryConditions[0] != (ObjectCondition{IfMatchETag: legacyETag}) {
		t.Fatalf("retry write conditions = %#v; want If-Match %q", backend.retryConditions, legacyETag)
	}
	if len(backend.invalidations) == 0 || !containsString(backend.invalidations[len(backend.invalidations)-1], "/_artifacts/sre/old.html") {
		t.Fatalf("legacy paths missing from invalidation requests: %v", backend.invalidations)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("cache retry record was not handled by normal completion: %v", err)
	}
}

func TestSitePriorStateLoaderIgnoresLegacyPublishState(t *testing.T) {
	_, store, _ := sitePublishRecoveryFixture(t)
	legacySitePublishState(t, store, "missing committed generation")
	prior, err := sitePriorStateLoader(store, "sre")(context.Background())
	if err != nil || prior != nil {
		t.Fatalf("legacy prior-state load = %#v, %v; want nil, nil", prior, err)
	}
}

func TestLegacyPublishStateHeadGetRequiresMatchingETag(t *testing.T) {
	root, store, options := sitePublishRecoveryFixture(t)
	legacySitePublishState(t, store, "missing committed generation")
	addLegacyPublishChanges(t, root, store)
	probe := newSitePublishProbeBackend()
	probe.sitePublishScaleBackend = store
	probe.mismatchStateGetETag = true
	_, err := PublishSite(context.Background(), probe, options)
	if err == nil || !strings.Contains(err.Error(), "site publish state changed between HEAD and GET; retry site publish") {
		t.Fatalf("legacy HEAD/GET ETag mismatch error = %v", err)
	}
}
