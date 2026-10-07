package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
)

type controlKeyFixture struct {
	Site       []controlKeyRow `json:"site"`
	Global     []controlKeyRow `json:"global"`
	LegacySite []controlKeyRow `json:"legacySite"`
}

type controlKeyRow struct {
	ID  string   `json:"id"`
	Key string   `json:"key"`
	Ops []string `json:"ops"`
}

func loadControlKeyFixture(t *testing.T) controlKeyFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "terraform", "modules", "aws", "tests", "fixtures", "control-keys.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture controlKeyFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// TestControlKeyLayoutMatchesSharedFixture pins the CLI's control keys to the
// fixture that the AWS module's IAM coverage test reads (IMP-66). A control
// record added in the CLI without a fixture row fails here; a fixture row the
// IAM policy does not cover fails in terraform/modules/aws.
func TestControlKeyLayoutMatchesSharedFixture(t *testing.T) {
	fixture := loadControlKeyFixture(t)
	const site = "{site}"
	want := map[string]string{
		"site-lock": siteLockKey(site), "site-cache": siteCacheRetryKey(site),
		"publish-state": sitePublishStateKey(site), "preview-cleanup": previewCleanupKey(site),
		"registry-lock": registryLockKey, "application-lock": applicationLockKey,
		"registry-cleanup": registryCleanupKey, "app-cache-retry": appCacheRetryObjectKey,
	}
	got := map[string]string{}
	for _, row := range append(append([]controlKeyRow{}, fixture.Site...), fixture.Global...) {
		got[row.ID] = row.Key
	}
	if len(got) != len(want) {
		t.Fatalf("fixture ids = %v, want %v", got, want)
	}
	for id, key := range want {
		if got[id] != key {
			t.Errorf("fixture %s key = %q, CLI key = %q", id, got[id], key)
		}
	}
	for _, row := range fixture.Site {
		if !strings.HasPrefix(row.Key, siteControlPrefix(site)) {
			t.Errorf("per-site record %s = %q is outside %s", row.ID, row.Key, siteControlPrefix(site))
		}
	}
	for _, row := range fixture.Global {
		if strings.HasPrefix(row.Key, siteControlRoot) {
			t.Errorf("global record %s = %q must stay outside the per-site prefix", row.ID, row.Key)
		}
	}
	legacy := map[string]string{}
	for _, row := range fixture.LegacySite {
		legacy[row.ID] = row.Key
		if k := legacyKeyOf(site, want[row.ID]); k != row.Key {
			t.Errorf("legacy %s = %q, CLI legacy key = %q", row.ID, row.Key, k)
		}
	}
	if len(legacy) != len(fixture.Site) {
		t.Errorf("legacy rows = %d, per-site rows = %d", len(legacy), len(fixture.Site))
	}
}

// TestEveryControlKeyLiteralInSourceIsInFixture catches a new "_control/..."
// string literal in non-test CLI sources that has no fixture row.
func TestEveryControlKeyLiteralInSourceIsInFixture(t *testing.T) {
	fixture := loadControlKeyFixture(t)
	var known []string
	for _, rows := range [][]controlKeyRow{fixture.Site, fixture.Global, fixture.LegacySite} {
		for _, row := range rows {
			known = append(known, row.Key)
		}
	}
	literal := regexp.MustCompile(`"(_control/[^"]*)"`)
	root := filepath.Join("..", "..")
	var unknown []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range literal.FindAllStringSubmatch(string(data), -1) {
			covered := false
			for _, key := range known {
				covered = covered || strings.HasPrefix(strings.ReplaceAll(key, "{site}", "x"), match[1]) || strings.HasPrefix(key, match[1])
			}
			if !covered {
				unknown = append(unknown, path+": "+match[1])
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(unknown)
	if len(unknown) > 0 {
		t.Fatalf("control key literals missing from terraform/modules/aws/tests/fixtures/control-keys.json: %v", unknown)
	}
}

func seedLegacyObject(t *testing.T, backend *lockMemoryBackend, key string, body string) {
	t.Helper()
	if _, err := backend.PutObjectConditional(context.Background(), key, Object{Bytes: []byte(body), ContentType: "application/json", Metadata: map[string]string{"k": "v"}}, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatal(err)
	}
}

func legacyLockBody(site, state string) string {
	if state == "held" {
		return `{"schemaVersion":1,"site":"` + site + `","state":"held","owner":"old-cli","acquiredAt":"2026-10-01T00:00:00Z"}`
	}
	return `{"schemaVersion":1,"site":"` + site + `","state":"free"}`
}

// TestAcquireAdoptsLegacySiteRecordsAndRetiresLegacyLock covers the cutover:
// records move to the new keys, the legacy keys disappear, the legacy lock
// becomes a tombstone an older CLI refuses, and later acquisitions skip it.
func TestAcquireAdoptsLegacySiteRecordsAndRetiresLegacyLock(t *testing.T) {
	ctx := context.Background()
	backend := newLockMemoryBackend()
	seedLegacyObject(t, backend, legacySiteLockKey("sre"), legacyLockBody("sre", "free"))
	seedLegacyObject(t, backend, legacySiteCacheRetryKey("sre"), `{"schemaVersion":1,"site":"sre","paths":["/a"]}`)
	seedLegacyObject(t, backend, legacyPreviewCleanupKey("sre"), `{"cleanup":true}`)
	seedLegacyObject(t, backend, legacySitePublishStateKey("sre"), `legacy-state`)
	manager := SiteLockManager{Backend: backend, WaitLimit: time.Second, PollPeriod: time.Millisecond}

	snapshot, release, err := manager.Acquire(ctx, "sre")
	if err != nil || snapshot.State != "held" {
		t.Fatalf("Acquire() = %+v, %v", snapshot, err)
	}
	for key, want := range map[string]string{
		siteCacheRetryKey("sre"): `{"schemaVersion":1,"site":"sre","paths":["/a"]}`, previewCleanupKey("sre"): `{"cleanup":true}`,
		sitePublishStateKey("sre"): "legacy-state",
	} {
		object, _, err := backend.GetObject(ctx, key)
		if err != nil || string(object.Bytes) != want || object.Metadata["k"] != "v" {
			t.Errorf("adopted %s = %+v, %v; want %q with metadata", key, object, err, want)
		}
	}
	for _, key := range []string{legacySiteCacheRetryKey("sre"), legacyPreviewCleanupKey("sre"), legacySitePublishStateKey("sre")} {
		if _, _, err := backend.GetObject(ctx, key); !errors.Is(err, ErrObjectNotFound) {
			t.Errorf("legacy record %s still present after adoption: %v", key, err)
		}
	}
	tombstone, _, err := backend.GetObject(ctx, legacySiteLockKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	if err := compat.CheckSchemaVersion("site lock record", tombstone.Bytes, 1); !compat.Is(err) {
		t.Fatalf("legacy lock = %s; an older CLI must refuse it with a schema error, got %v", tombstone.Bytes, err)
	}
	if _, err := decodeLockRecord(tombstone.Bytes, "sre"); err == nil {
		t.Fatal("older lock decoding accepted the tombstone")
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}

	// Warm acquisitions never touch the legacy keys again.
	reads := 0
	backend.afterRead = func(key string) {
		if strings.HasPrefix(key, "_control/locks/sites/") {
			reads++
		}
	}
	_, release, err = manager.Acquire(ctx, "sre")
	if err != nil || release() != nil {
		t.Fatalf("warm Acquire() = %v", err)
	}
	if reads != 0 {
		t.Fatalf("warm Acquire() read the legacy lock %d times", reads)
	}
}

// TestAcquireWaitsForOlderCLIHoldingLegacyLock is the mutual-exclusion half:
// while an older CLI holds the legacy lock, the new CLI neither moves records
// nor claims its own lock; after an operator recovers a stale legacy lock it
// proceeds.
func TestAcquireWaitsForOlderCLIHoldingLegacyLock(t *testing.T) {
	ctx := context.Background()
	backend := newLockMemoryBackend()
	seedLegacyObject(t, backend, legacySiteLockKey("sre"), legacyLockBody("sre", "held"))
	seedLegacyObject(t, backend, legacySitePublishStateKey("sre"), `legacy-state`)
	manager := SiteLockManager{Backend: backend, WaitLimit: 50 * time.Millisecond, PollPeriod: time.Millisecond}

	if _, release, err := manager.Acquire(ctx, "sre"); err == nil {
		_ = release()
		t.Fatal("Acquire() succeeded while an older CLI held the legacy lock")
	}
	if _, _, err := backend.GetObject(ctx, siteLockKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("new lock was claimed while the legacy lock was held: %v", err)
	}
	if _, _, err := backend.GetObject(ctx, sitePublishStateKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("records moved while the legacy lock was held: %v", err)
	}
	snapshot, err := manager.Inspect(ctx, "sre")
	if err != nil || snapshot.State != "held" || snapshot.Owner != "old-cli" {
		t.Fatalf("Inspect() = %+v, %v; want the legacy holder", snapshot, err)
	}
	if err := manager.Recover(ctx, "sre", snapshot.ETag); err != nil {
		t.Fatalf("Recover(legacy lock) = %v", err)
	}
	manager.WaitLimit = time.Second
	if _, release, err := manager.Acquire(ctx, "sre"); err != nil || release() != nil {
		t.Fatalf("Acquire() after recovery = %v", err)
	}
}

// TestLegacyRecordCannotOverrideNewerState: when both keys exist, the current
// key wins and the stale legacy key is removed rather than adopted.
func TestLegacyRecordCannotOverrideNewerState(t *testing.T) {
	ctx := context.Background()
	backend := newLockMemoryBackend()
	seedLegacyObject(t, backend, legacySiteLockKey("sre"), legacyLockBody("sre", "free"))
	seedLegacyObject(t, backend, legacySitePublishStateKey("sre"), `stale`)
	seedLegacyObject(t, backend, sitePublishStateKey("sre"), `newer`)
	manager := SiteLockManager{Backend: backend, WaitLimit: time.Second, PollPeriod: time.Millisecond}
	if _, release, err := manager.Acquire(ctx, "sre"); err != nil || release() != nil {
		t.Fatalf("Acquire() = %v", err)
	}
	object, _, err := backend.GetObject(ctx, sitePublishStateKey("sre"))
	if err != nil || string(object.Bytes) != "newer" {
		t.Fatalf("state = %+v, %v; want the newer record untouched", object, err)
	}
	if _, _, err := backend.GetObject(ctx, legacySitePublishStateKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("stale legacy state remains: %v", err)
	}
}

// TestDryRunReadsLegacyRecordsWithoutMigrating: read-only callers see the
// legacy state a real run would adopt, and write nothing.
func TestDryRunReadsLegacyRecordsWithoutMigrating(t *testing.T) {
	ctx := context.Background()
	backend := newLockMemoryBackend()
	seedLegacyObject(t, backend, legacySitePublishStateKey("sre"), `legacy-state`)
	object, _, err := getSiteControl(ctx, backend, "sre", sitePublishStateKey("sre"))
	if err != nil || string(object.Bytes) != "legacy-state" {
		t.Fatalf("getSiteControl() = %+v, %v", object, err)
	}
	if _, err := headSiteControl(ctx, backend, "sre", sitePublishStateKey("sre")); err != nil {
		t.Fatalf("headSiteControl() = %v", err)
	}
	if _, _, err := backend.GetObject(ctx, sitePublishStateKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("read-only fallback wrote the current key: %v", err)
	}
	locked := context.WithValue(ctx, previewSiteLockContextKey{}, previewSiteLock{site: "sre", owner: "o", etag: "e"})
	if _, _, err := getSiteControl(locked, backend, "sre", sitePublishStateKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("locked caller fell back to the legacy key: %v", err)
	}
}

// TestPublishSiteAdoptsOldLayoutStateAsNoOp is the end-to-end fallback fixture:
// a bucket whose site state and lock sit at the pre-IMP-66 keys is adopted by
// the next publish, which then sees an unchanged site instead of republishing.
func TestPublishSiteAdoptsOldLayoutStateAsNoOp(t *testing.T) {
	ctx := context.Background()
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	if initial, err := PublishSite(ctx, backend, options); err != nil || initial.Outcome != "synced" {
		t.Fatalf("initial PublishSite() = %+v, err=%v", initial, err)
	}
	// Rewind the control plane to the old layout.
	state, _, err := backend.GetObject(ctx, sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backend.PutObjectConditional(ctx, legacySitePublishStateKey("sre"), state, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatal(err)
	}
	seedLegacyObject(t, backend.lockMemoryBackend, legacySiteLockKey("sre"), legacyLockBody("sre", "free"))
	if err := backend.DeleteObjects(ctx, []string{sitePublishStateKey("sre"), siteLockKey("sre")}); err != nil {
		t.Fatal(err)
	}

	dry := options
	dry.DryRun = true
	if planned, err := PublishSite(ctx, backend, dry); err != nil || planned.Outcome != "no-op" {
		t.Fatalf("dry-run over old layout = %+v, err=%v; want no-op through the legacy read-through", planned, err)
	}
	if _, _, err := backend.GetObject(ctx, sitePublishStateKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("dry-run migrated state: %v", err)
	}

	result, err := PublishSite(ctx, backend, options)
	if err != nil || result.Outcome != "no-op" {
		t.Fatalf("PublishSite() over old layout = %+v, err=%v; want no-op", result, err)
	}
	if _, _, err := backend.GetObject(ctx, sitePublishStateKey("sre")); err != nil {
		t.Fatalf("state was not adopted: %v", err)
	}
	if _, _, err := backend.GetObject(ctx, legacySitePublishStateKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("legacy state remains: %v", err)
	}
}

// The per-site IAM prefix is only an isolation boundary if a site identifier
// can never contain a path separator or dot segment.
func TestSiteIdentifiersCannotEscapeTheirControlPrefix(t *testing.T) {
	for _, site := range []string{"a/b", "a/../b", "..", ".", "a.b", "A", "a/", "/a", "a b", ""} {
		if err := validateLockSite(site); err == nil {
			t.Errorf("validateLockSite(%q) accepted a site identifier that could escape %s", site, siteControlPrefix("x"))
		}
	}
}
