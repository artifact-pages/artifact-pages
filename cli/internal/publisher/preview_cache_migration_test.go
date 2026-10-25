package publisher

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

const (
	migrationLegacyCatalogCache = "public, max-age=0, s-maxage=60, must-revalidate"
	migrationLegacyFileCache    = "public, max-age=0, s-maxage=300, must-revalidate"
	migrationSHAOne             = "1111111111111111111111111111111111111111"
	migrationSHATwo             = "2222222222222222222222222222222222222222"
)

// migrationBackend records and can fault conditional writes to preview objects.
type migrationBackend struct {
	*lockMemoryBackend
	hookMu     sync.Mutex
	previewPut []string
	conditions []ObjectCondition
	beforePut  func(index int, key string) error
	afterPut   func(index int, key string)
}

func newMigrationBackend() *migrationBackend {
	return &migrationBackend{lockMemoryBackend: newLockMemoryBackend()}
}

func (backend *migrationBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	if !strings.HasPrefix(key, "_previews/") {
		return backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	}
	backend.hookMu.Lock()
	index := len(backend.previewPut)
	backend.previewPut = append(backend.previewPut, key)
	backend.conditions = append(backend.conditions, condition)
	before, after := backend.beforePut, backend.afterPut
	backend.hookMu.Unlock()
	if before != nil {
		if err := before(index, key); err != nil {
			return "", err
		}
	}
	etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	if err == nil && after != nil {
		after(index, key)
	}
	return etag, err
}

func (backend *migrationBackend) previewWrites() []string {
	backend.hookMu.Lock()
	defer backend.hookMu.Unlock()
	return append([]string(nil), backend.previewPut...)
}

type migrationObjectState struct {
	Object Object
	ETag   string
}

func (backend *migrationBackend) snapshot() map[string]migrationObjectState {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	state := make(map[string]migrationObjectState, len(backend.objects))
	for key, object := range backend.objects {
		object.Bytes = append([]byte(nil), object.Bytes...)
		state[key] = migrationObjectState{Object: object, ETag: backend.etags[key]}
	}
	return state
}

func (backend *migrationBackend) seed(t *testing.T, key string, object Object) {
	t.Helper()
	if _, err := backend.lockMemoryBackend.PutObjectConditional(context.Background(), key, object, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatalf("seed %s: %v", key, err)
	}
}

func (backend *migrationBackend) remove(keys ...string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for _, key := range keys {
		delete(backend.objects, key)
		delete(backend.etags, key)
	}
}

// seedMigrationSite writes a legacy-header preview site: shaOne owns a.md and
// b.md, shaTwo owns c.md and is shared by two groups.
func seedMigrationSite(t *testing.T, backend *migrationBackend, site string) {
	t.Helper()
	revisions := map[string][]string{migrationSHAOne: {"a.md", "b.md"}, migrationSHATwo: {"c.md"}}
	catalog := preview.Catalog{
		SchemaVersion: preview.SchemaVersion, Site: site,
		Groups: []preview.Group{previewRemoveTestGroup("pr:1", migrationSHATwo), previewRemoveTestGroup("pr:2", migrationSHATwo)},
		RevisionHistory: []preview.GroupRevisionHistory{
			ownership("pr:1", preview.RevisionOwnership{HeadSHA: migrationSHAOne, Files: []string{"a.md", "b.md"}}, preview.RevisionOwnership{HeadSHA: migrationSHATwo, Files: []string{"c.md"}}),
			ownership("pr:2", preview.RevisionOwnership{HeadSHA: migrationSHATwo, Files: []string{"c.md"}}),
		},
	}
	catalogBytes, err := preview.EncodeCatalog(catalog)
	if err != nil {
		t.Fatal(err)
	}
	metadata := map[string]string{"artifact-pages-preview": "true"}
	backend.seed(t, "_previews/"+site+"/catalog.json", Object{Bytes: catalogBytes, ContentType: "application/json; charset=utf-8", ContentDisposition: "inline", Cache: migrationLegacyCatalogCache, Metadata: metadata})
	for sha, files := range revisions {
		manifest, _ := previewRemoveTestManifest(site, sha, files...)
		manifestBytes, err := preview.EncodeManifest(manifest)
		if err != nil {
			t.Fatal(err)
		}
		backend.seed(t, "_previews/"+site+"/revisions/"+sha+"/manifest.json", Object{Bytes: manifestBytes, ContentType: "application/json; charset=utf-8", ContentDisposition: "inline", Cache: migrationLegacyFileCache, Metadata: metadata})
		for _, file := range files {
			backend.seed(t, "_previews/"+site+"/revisions/"+sha+"/files/"+file, Object{Bytes: []byte("body: " + file), ContentType: "text/markdown; charset=utf-8", ContentDisposition: "inline", ContentEncoding: "identity", Cache: migrationLegacyFileCache, Metadata: metadata})
		}
	}
}

func migrationKeys(site string) []string {
	return []string{
		"_previews/" + site + "/catalog.json",
		"_previews/" + site + "/revisions/" + migrationSHAOne + "/manifest.json",
		"_previews/" + site + "/revisions/" + migrationSHAOne + "/files/a.md",
		"_previews/" + site + "/revisions/" + migrationSHAOne + "/files/b.md",
		"_previews/" + site + "/revisions/" + migrationSHATwo + "/manifest.json",
		"_previews/" + site + "/revisions/" + migrationSHATwo + "/files/c.md",
	}
}

func migrate(t *testing.T, backend ConditionalObjectBackend, site string, apply bool) (PreviewCacheMigrationResult, error) {
	t.Helper()
	return MigratePreviewCacheMetadata(context.Background(), backend, PreviewCacheMigrationOptions{SiteID: site, Apply: apply})
}

func TestMigratePreviewCacheMetadataDryRunWritesNothing(t *testing.T) {
	backend := newMigrationBackend()
	seedMigrationSite(t, backend, "sre")
	before := backend.snapshot()
	result, err := migrate(t, backend, "sre", false)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "planned" || result.Updated != 6 || result.Current != 0 || result.ExpiredRevisions != 0 || len(result.Objects) != 6 {
		t.Fatalf("dry-run result = %+v", result)
	}
	if after := backend.snapshot(); !reflect.DeepEqual(before, after) {
		t.Fatal("dry-run changed objects, ETags or took a lock record")
	}
	if writes := backend.previewWrites(); len(writes) != 0 {
		t.Fatalf("dry-run preview writes = %v", writes)
	}
}

func TestMigratePreviewCacheMetadataApplyRewritesOnlyCacheControl(t *testing.T) {
	backend := newMigrationBackend()
	seedMigrationSite(t, backend, "sre")
	before := backend.snapshot()
	result, err := migrate(t, backend, "sre", true)
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != "migrated" || result.Updated != 6 {
		t.Fatalf("apply result = %+v", result)
	}
	after := backend.snapshot()
	for _, key := range migrationKeys("sre") {
		want := before[key].Object
		want.Cache = cacheControl(cacheClassPreviewFile)
		if strings.HasSuffix(key, "/catalog.json") {
			want.Cache = cacheControl(cacheClassPreviewCatalog)
		}
		if !reflect.DeepEqual(after[key].Object, want) {
			t.Errorf("%s = %+v, want only Cache replaced: %+v", key, after[key].Object, want)
		}
		if after[key].ETag == before[key].ETag {
			t.Errorf("%s ETag unchanged; expected a rewrite", key)
		}
	}
	manifest, err := preview.DecodeManifest(after[migrationKeys("sre")[1]].Object.Bytes)
	if err != nil || manifest.CreatedAt != "2026-10-06T00:00:00Z" || manifest.HeadSHA != migrationSHAOne {
		t.Fatalf("manifest after migration = %+v, err=%v", manifest, err)
	}
	for key := range after {
		if !strings.HasPrefix(key, "_previews/") && !reflect.DeepEqual(after[key], before[key]) && !strings.HasPrefix(key, "_control/") {
			t.Errorf("non-preview object %s changed", key)
		}
	}
	writesAfterApply := len(backend.previewWrites())
	if writesAfterApply != 6 {
		t.Fatalf("preview writes = %d, want 6", writesAfterApply)
	}
	again, err := migrate(t, backend, "sre", true)
	if err != nil {
		t.Fatal(err)
	}
	if again.Outcome != "no-op" || again.Updated != 0 || again.Current != 6 {
		t.Fatalf("rerun = %+v", again)
	}
	for _, object := range again.Objects {
		if object.Action != "current" {
			t.Errorf("rerun object %+v, want current", object)
		}
	}
	if len(backend.previewWrites()) != writesAfterApply {
		t.Fatal("rerun wrote objects")
	}
	dry, err := migrate(t, backend, "sre", false)
	if err != nil || dry.Outcome != "no-op" {
		t.Fatalf("dry-run after apply = %+v, err=%v", dry, err)
	}
}

func TestMigratePreviewCacheMetadataLeavesOrphansAndOtherSitesUntouched(t *testing.T) {
	backend := newMigrationBackend()
	seedMigrationSite(t, backend, "sre")
	seedMigrationSite(t, backend, "other")
	orphan := "_previews/sre/revisions/" + migrationSHAOne + "/files/orphan.txt"
	backend.seed(t, orphan, Object{Bytes: []byte("partial upload"), Cache: migrationLegacyFileCache})
	before := backend.snapshot()
	if _, err := migrate(t, backend, "sre", true); err != nil {
		t.Fatal(err)
	}
	after := backend.snapshot()
	if !reflect.DeepEqual(before[orphan], after[orphan]) {
		t.Error("orphan object was modified")
	}
	for _, key := range migrationKeys("other") {
		if !reflect.DeepEqual(before[key], after[key]) {
			t.Errorf("other site object %s was modified", key)
		}
	}
	for _, write := range backend.previewWrites() {
		if strings.HasPrefix(write, "_previews/other/") || write == orphan {
			t.Errorf("unexpected write %s", write)
		}
	}
}

func TestMigratePreviewCacheMetadataRejectsUnsafeOwnershipBeforeAnyWrite(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(t *testing.T, backend *migrationBackend)
		want   string
	}{
		{"ledger path traversal", func(t *testing.T, backend *migrationBackend) {
			replaceMigrationObject(t, backend, migrationKeys("sre")[0], func(text string) string { return strings.Replace(text, `"a.md"`, `"../other/a.md"`, 1) })
		}, "source-relative path"},
		{"ledger for another site", func(t *testing.T, backend *migrationBackend) {
			replaceMigrationObject(t, backend, migrationKeys("sre")[0], func(text string) string { return strings.Replace(text, `"site": "sre"`, `"site": "other"`, 1) })
		}, "does not match"},
		{"manifest path traversal", func(t *testing.T, backend *migrationBackend) {
			replaceMigrationObject(t, backend, migrationKeys("sre")[1], func(text string) string { return strings.Replace(text, `"a.md"`, `"../../other/a.md"`, 1) })
		}, "source-relative path"},
		{"manifest for another revision", func(t *testing.T, backend *migrationBackend) {
			replaceMigrationObject(t, backend, migrationKeys("sre")[1], func(text string) string { return strings.Replace(text, migrationSHAOne, migrationSHATwo, 1) })
		}, "does not match"},
		{"manifest file list differs from ledger", func(t *testing.T, backend *migrationBackend) {
			replaceMigrationObject(t, backend, migrationKeys("sre")[1], func(text string) string { return strings.Replace(text, `"b.md"`, `"z.md"`, 1) })
		}, "does not match"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			backend := newMigrationBackend()
			seedMigrationSite(t, backend, "sre")
			test.mutate(t, backend)
			for _, apply := range []bool{false, true} {
				before := backend.snapshot()
				_, err := migrate(t, backend, "sre", apply)
				if err == nil || (test.want != "" && !strings.Contains(err.Error(), test.want)) {
					t.Fatalf("apply=%v error = %v, want failure containing %q", apply, err, test.want)
				}
				if len(backend.previewWrites()) != 0 {
					t.Fatalf("writes before failure: %v", backend.previewWrites())
				}
				if apply {
					// Only lock records may differ from the snapshot.
					after := backend.snapshot()
					for key := range after {
						if strings.HasPrefix(key, "_previews/") && !reflect.DeepEqual(before[key], after[key]) {
							t.Errorf("%s changed", key)
						}
					}
				}
			}
		})
	}
}

func replaceMigrationObject(t *testing.T, backend *migrationBackend, key string, edit func(string) string) {
	t.Helper()
	backend.mu.Lock()
	defer backend.mu.Unlock()
	object := backend.objects[key]
	updated := edit(string(object.Bytes))
	if updated == string(object.Bytes) {
		t.Fatalf("edit of %s changed nothing: %s", key, object.Bytes)
	}
	object.Bytes = []byte(updated)
	backend.objects[key] = object
}

func TestMigratePreviewCacheMetadataHandlesRetentionExpiry(t *testing.T) {
	keys := migrationKeys("sre")
	t.Run("fully expired revision is skipped", func(t *testing.T) {
		backend := newMigrationBackend()
		seedMigrationSite(t, backend, "sre")
		backend.remove(keys[1], keys[2], keys[3])
		result, err := migrate(t, backend, "sre", true)
		if err != nil {
			t.Fatal(err)
		}
		if result.Outcome != "migrated" || result.Updated != 3 || result.ExpiredRevisions != 1 {
			t.Fatalf("result = %+v", result)
		}
		expired := 0
		for _, object := range result.Objects {
			if object.Action == "expired" {
				expired++
			}
		}
		if expired != 1 {
			t.Fatalf("expired objects = %+v", result.Objects)
		}
	})
	for _, test := range []struct {
		name   string
		remove []string
		want   string
	}{
		{"manifest missing with files present", []string{keys[1]}, "still has owned file"},
		{"file missing with manifest present", []string{keys[3]}, "missing owned file b.md"},
	} {
		t.Run(test.name, func(t *testing.T) {
			backend := newMigrationBackend()
			seedMigrationSite(t, backend, "sre")
			backend.remove(test.remove...)
			for _, apply := range []bool{false, true} {
				_, err := migrate(t, backend, "sre", apply)
				if err == nil || !strings.Contains(err.Error(), test.want) {
					t.Fatalf("apply=%v error = %v, want %q", apply, err, test.want)
				}
			}
			if len(backend.previewWrites()) != 0 {
				t.Fatalf("writes = %v", backend.previewWrites())
			}
		})
	}
}

func TestMigratePreviewCacheMetadataFailsClosedOnUnsupportedHeader(t *testing.T) {
	for _, header := range []string{"", "public, max-age=999", migrationLegacyCatalogCache} {
		// The catalog legacy value is invalid for a file; it is accepted only for the catalog class.
		t.Run("file header "+header, func(t *testing.T) {
			backend := newMigrationBackend()
			seedMigrationSite(t, backend, "sre")
			replaceCache(backend, migrationKeys("sre")[5], header)
			_, err := migrate(t, backend, "sre", true)
			if err == nil || !strings.Contains(err.Error(), "unsupported Cache-Control policy") || !strings.Contains(err.Error(), migrationKeys("sre")[5]) {
				t.Fatalf("error = %v", err)
			}
			if len(backend.previewWrites()) != 0 {
				t.Fatalf("writes = %v", backend.previewWrites())
			}
		})
	}
	t.Run("catalog header", func(t *testing.T) {
		backend := newMigrationBackend()
		seedMigrationSite(t, backend, "sre")
		replaceCache(backend, migrationKeys("sre")[0], "")
		if _, err := migrate(t, backend, "sre", true); err == nil || !strings.Contains(err.Error(), "unsupported Cache-Control policy") {
			t.Fatalf("error = %v", err)
		}
		if len(backend.previewWrites()) != 0 {
			t.Fatalf("writes = %v", backend.previewWrites())
		}
	})
}

func replaceCache(backend *migrationBackend, key, cache string) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	object := backend.objects[key]
	object.Cache = cache
	backend.objects[key] = object
}

func TestMigratePreviewCacheMetadataStopsOnCASFailureAndRerunConverges(t *testing.T) {
	backend := newMigrationBackend()
	seedMigrationSite(t, backend, "sre")
	keys := migrationKeys("sre")
	backend.beforePut = func(index int, key string) error {
		if index == 1 {
			return ErrPreconditionFailed
		}
		return nil
	}
	result, err := migrate(t, backend, "sre", true)
	if err == nil || !errors.Is(err, ErrPreconditionFailed) || !strings.Contains(err.Error(), keys[1]) {
		t.Fatalf("error = %v, want precondition failure naming %s", err, keys[1])
	}
	if result.Outcome == "migrated" {
		t.Fatalf("result outcome = %q after failure", result.Outcome)
	}
	if writes := backend.previewWrites(); len(writes) != 2 {
		t.Fatalf("writes = %v, want stop after the failed second write", writes)
	}
	state := backend.snapshot()
	if state[keys[0]].Object.Cache != cacheControl(cacheClassPreviewCatalog) {
		t.Error("first object was not updated before failure")
	}
	if state[keys[1]].Object.Cache != migrationLegacyFileCache {
		t.Error("failed object changed")
	}
	backend.beforePut = nil
	rerun, err := migrate(t, backend, "sre", true)
	if err != nil {
		t.Fatal(err)
	}
	if rerun.Outcome != "migrated" || rerun.Updated != 5 || rerun.Current != 1 {
		t.Fatalf("rerun = %+v", rerun)
	}
}

func TestMigratePreviewCacheMetadataRequiresAndKeepsSiteLock(t *testing.T) {
	t.Run("held by another owner", func(t *testing.T) {
		backend := newMigrationBackend()
		seedMigrationSite(t, backend, "sre")
		_, release, err := (SiteLockManager{Backend: backend}).Acquire(context.Background(), "sre")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = release() }()
		ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
		defer cancel()
		_, err = MigratePreviewCacheMetadata(ctx, backend, PreviewCacheMigrationOptions{SiteID: "sre", Apply: true})
		if err == nil {
			t.Fatal("expected failure while another owner holds the lock")
		}
		if len(backend.previewWrites()) != 0 {
			t.Fatalf("writes = %v", backend.previewWrites())
		}
	})
	t.Run("lock changed between writes", func(t *testing.T) {
		backend := newMigrationBackend()
		seedMigrationSite(t, backend, "sre")
		backend.afterPut = func(index int, key string) {
			if index == 0 {
				backend.mu.Lock()
				backend.etags[siteLockKey("sre")] = `"stolen"`
				backend.mu.Unlock()
			}
		}
		_, err := migrate(t, backend, "sre", true)
		if err == nil || !errors.Is(err, ErrPreconditionFailed) {
			t.Fatalf("error = %v, want lock loss", err)
		}
		if writes := backend.previewWrites(); len(writes) != 1 {
			t.Fatalf("writes = %v, want exactly the first", writes)
		}
	})
}

func TestMigratePreviewCacheMetadataEdgeCases(t *testing.T) {
	backend := newMigrationBackend()
	result, err := migrate(t, backend, "sre", true)
	if err != nil || result.Outcome != "no-op" || len(result.Objects) != 0 {
		t.Fatalf("missing catalog = %+v, err=%v", result, err)
	}
	if _, err := migrate(t, backend, "../escape", true); err == nil {
		t.Fatal("expected invalid site error")
	}
	if _, err := MigratePreviewCacheMetadata(context.Background(), nil, PreviewCacheMigrationOptions{SiteID: "sre"}); err == nil {
		t.Fatal("expected nil backend error")
	}
}

// Regression: an ordinary same-head preview publish retry never rewrites
// existing revision objects, so the migration helper is never implicit.
// Related: TestObjectPreviewStoreCreatesImmutableObjectsOnce.
func TestPreviewPublishSameHeadRetryLeavesLegacyRevisionObjectsUntouched(t *testing.T) {
	backend := newMigrationBackend()
	store, err := NewObjectPreviewStore(backend)
	if err != nil {
		t.Fatal(err)
	}
	result := previewAdapterBuildResult("sre", "pr:42", "https://github.com/acme/sre/pull/42", "0123456789abcdef0123456789abcdef01234567")
	if err := preview.Publish(context.Background(), store, result); err != nil {
		t.Fatal(err)
	}
	prefix := "_previews/sre/revisions/"
	backend.mu.Lock()
	for key, object := range backend.objects {
		if strings.HasPrefix(key, prefix) {
			object.Cache = migrationLegacyFileCache
			backend.objects[key] = object
			backend.etags[key] = `"legacy-` + key + `"`
		}
	}
	backend.mu.Unlock()
	before := backend.snapshot()
	if err := preview.Publish(context.Background(), store, result); err != nil {
		t.Fatal(err)
	}
	after := backend.snapshot()
	revisionObjects := 0
	for key := range before {
		if strings.HasPrefix(key, prefix) {
			revisionObjects++
			if !reflect.DeepEqual(before[key], after[key]) {
				t.Errorf("same-head retry rewrote %s", key)
			}
		}
	}
	if revisionObjects == 0 {
		t.Fatal("no revision objects to compare")
	}
}

func TestMigratePreviewCacheMetadataWritesAreConditionalOnTheValidatedETag(t *testing.T) {
	backend := newMigrationBackend()
	seedMigrationSite(t, backend, "sre")
	before := backend.snapshot()
	if _, err := migrate(t, backend, "sre", true); err != nil {
		t.Fatal(err)
	}
	writes := backend.previewWrites()
	backend.hookMu.Lock()
	conditions := append([]ObjectCondition(nil), backend.conditions...)
	backend.hookMu.Unlock()
	if len(writes) != 6 || len(conditions) != 6 {
		t.Fatalf("writes = %v, conditions = %v", writes, conditions)
	}
	for index, key := range writes {
		if conditions[index].IfNoneMatch || conditions[index].IfMatchETag == "" || conditions[index].IfMatchETag != before[key].ETag {
			t.Errorf("write %s condition = %+v, want If-Match %q", key, conditions[index], before[key].ETag)
		}
	}
}

func TestMigratePreviewCacheMetadataDoesNotOverwriteObjectsChangedAfterPlanning(t *testing.T) {
	keys := migrationKeys("sre")
	mutate := func(backend *migrationBackend, key string) Object {
		backend.mu.Lock()
		defer backend.mu.Unlock()
		object := backend.objects[key]
		object.Bytes = append([]byte(nil), []byte("changed concurrently")...)
		object.Cache = "public, max-age=999"
		backend.objects[key] = object
		backend.etags[key] = `"mutated"`
		return object
	}
	t.Run("second target", func(t *testing.T) {
		backend := newMigrationBackend()
		seedMigrationSite(t, backend, "sre")
		var mutated Object
		backend.afterPut = func(index int, key string) {
			if index == 0 {
				mutated = mutate(backend, keys[1])
			}
		}
		_, err := migrate(t, backend, "sre", true)
		if err == nil || !errors.Is(err, ErrPreconditionFailed) || !strings.Contains(err.Error(), keys[1]) {
			t.Fatalf("error = %v, want precondition failure naming %s", err, keys[1])
		}
		state := backend.snapshot()[keys[1]]
		if !reflect.DeepEqual(state.Object, mutated) || state.ETag != `"mutated"` {
			t.Fatalf("mutated object was overwritten: %+v", state)
		}
		if writes := backend.previewWrites(); len(writes) != 2 {
			t.Fatalf("writes = %v, want stop at the failed second write", writes)
		}
	})
	t.Run("catalog changed before its write", func(t *testing.T) {
		backend := newMigrationBackend()
		seedMigrationSite(t, backend, "sre")
		var mutated Object
		backend.beforePut = func(index int, key string) error {
			if index == 0 {
				mutated = mutate(backend, keys[0])
			}
			return nil
		}
		_, err := migrate(t, backend, "sre", true)
		if err == nil || !errors.Is(err, ErrPreconditionFailed) || !strings.Contains(err.Error(), keys[0]) {
			t.Fatalf("error = %v, want precondition failure naming %s", err, keys[0])
		}
		state := backend.snapshot()[keys[0]]
		if !reflect.DeepEqual(state.Object, mutated) {
			t.Fatalf("unvalidated catalog bytes were written: %+v", state.Object)
		}
	})
}
