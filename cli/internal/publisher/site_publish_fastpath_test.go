package publisher

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type sitePublishProbeBackend struct {
	*sitePublishScaleBackend
	probeMu              sync.Mutex
	stateHeads           int
	stateGets            int
	stateWrites          int
	projectionHeads      int
	projectionLists      int
	projectionWrites     []string
	failStateWriteAt     int
	journalWrites        int
	failJournalWriteAt   int
	mismatchStateGetETag bool
}

func newSitePublishProbeBackend() *sitePublishProbeBackend {
	return &sitePublishProbeBackend{sitePublishScaleBackend: newSitePublishScaleBackend()}
}

type sitePublishGetOnlyProbeBackend struct{ *sitePublishProbeBackend }

func (*sitePublishGetOnlyProbeBackend) publishStateReadMode() publishStateReadMode {
	return publishStateReadGetOnly
}

func (backend *sitePublishProbeBackend) resetProbe() {
	backend.probeMu.Lock()
	backend.stateHeads = 0
	backend.stateGets = 0
	backend.stateWrites = 0
	backend.projectionHeads = 0
	backend.projectionLists = 0
	backend.projectionWrites = nil
	backend.failStateWriteAt = 0
	backend.journalWrites = 0
	backend.failJournalWriteAt = 0
	backend.mismatchStateGetETag = false
	backend.probeMu.Unlock()
	backend.sitePublishScaleBackend.resetCounts()
}

func (backend *sitePublishProbeBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	backend.probeMu.Lock()
	if key == sitePublishStateKey("sre") {
		backend.stateHeads++
	} else if strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/") {
		backend.projectionHeads++
	}
	backend.probeMu.Unlock()
	return backend.sitePublishScaleBackend.HeadObject(ctx, key)
}

func (backend *sitePublishProbeBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	backend.probeMu.Lock()
	stateKey := key == sitePublishStateKey("sre")
	if stateKey {
		backend.stateGets++
	}
	mismatch := stateKey && backend.mismatchStateGetETag
	backend.probeMu.Unlock()
	object, etag, err := backend.sitePublishScaleBackend.GetObject(ctx, key)
	if err == nil && mismatch {
		etag += "-changed"
	}
	return object, etag, err
}

func (backend *sitePublishProbeBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	backend.probeMu.Lock()
	if strings.HasPrefix(prefix, "_artifacts/sre/") || strings.HasPrefix(prefix, "_indexes/sre/") {
		backend.projectionLists++
	}
	backend.probeMu.Unlock()
	return backend.sitePublishScaleBackend.ListKeys(ctx, prefix)
}

func (backend *sitePublishProbeBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.probeMu.Lock()
	if key == sitePublishStateKey("sre") {
		backend.stateWrites++
		if backend.failStateWriteAt > 0 && backend.stateWrites == backend.failStateWriteAt {
			backend.probeMu.Unlock()
			return "", errors.New("injected site publish state CAS failure")
		}
	} else if key == siteCacheRetryKey("sre") {
		backend.journalWrites++
		if backend.failJournalWriteAt > 0 && backend.journalWrites == backend.failJournalWriteAt {
			backend.probeMu.Unlock()
			return "", errors.New("injected site publish journal CAS failure")
		}
	}
	backend.probeMu.Unlock()
	return backend.sitePublishScaleBackend.PutObjectConditional(ctx, key, object, condition)
}

func (backend *sitePublishProbeBackend) PutObject(ctx context.Context, key string, object Object) error {
	if strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/") {
		backend.probeMu.Lock()
		backend.projectionWrites = append(backend.projectionWrites, "put:"+key)
		backend.probeMu.Unlock()
	}
	return backend.sitePublishScaleBackend.PutObject(ctx, key, object)
}

func (backend *sitePublishProbeBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.probeMu.Lock()
	for _, key := range keys {
		if strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/") {
			backend.projectionWrites = append(backend.projectionWrites, "delete:"+key)
		}
	}
	backend.probeMu.Unlock()
	return backend.sitePublishScaleBackend.DeleteObjects(ctx, keys)
}

func TestPublishSiteNoOpSkipsBuildManifestAndProjectionInventory(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	initial, err := PublishSite(context.Background(), backend, options)
	if err != nil || initial.Outcome != "published" {
		t.Fatalf("initial PublishSite() = %+v, err=%v", initial, err)
	}

	backend.resetProbe()
	result, err := PublishSite(context.Background(), backend, options)
	if err != nil {
		t.Fatalf("no-op PublishSite() error = %v", err)
	}
	if result.Outcome != "no-op" || !result.BuildSkipped || len(result.Changes) != 0 {
		t.Fatalf("no-op PublishSite() = %+v, want no-op with build skipped and no changes", result)
	}
	backend.probeMu.Lock()
	stateHeads, stateGets, stateWrites := backend.stateHeads, backend.stateGets, backend.stateWrites
	projectionHeads, projectionLists := backend.projectionHeads, backend.projectionLists
	backend.probeMu.Unlock()
	if stateHeads != 1 || stateGets != 0 || stateWrites != 0 || projectionHeads != 0 || projectionLists != 0 {
		t.Fatalf("no-op remote probes: state HEAD/GET/PUT=%d/%d/%d projection HEAD/LIST=%d/%d; want 1/0/0 and 0/0", stateHeads, stateGets, stateWrites, projectionHeads, projectionLists)
	}
	calls, _, _, bytesWritten := backend.sitePublishScaleBackend.countSnapshot()
	if calls["GET"] == 0 || calls["PUT"] == 0 || calls["LIST"] != 0 || bytesWritten == 0 {
		t.Fatalf("no-op mandatory control work was lost or projection work appeared: calls=%v bytesWritten=%d", calls, bytesWritten)
	}
}

func TestPublishSiteGetOnlyStatePolicyUsesCompleteGetMetadata(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	probe := newSitePublishProbeBackend()
	backend := &sitePublishGetOnlyProbeBackend{sitePublishProbeBackend: probe}
	seedPublisherRegistry(t, probe.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	initial, err := PublishSite(context.Background(), backend, options)
	if err != nil || initial.Outcome != "published" {
		t.Fatalf("initial GET-only PublishSite() = %+v, err=%v", initial, err)
	}

	probe.resetProbe()
	noop, err := PublishSite(context.Background(), backend, options)
	if err != nil || !noop.BuildSkipped || noop.Outcome != "no-op" {
		t.Fatalf("GET-only no-op = %+v, err=%v", noop, err)
	}
	probe.probeMu.Lock()
	stateHeads, stateGets, stateWrites := probe.stateHeads, probe.stateGets, probe.stateWrites
	projectionWrites := len(probe.projectionWrites)
	probe.probeMu.Unlock()
	if stateHeads != 0 || stateGets != 1 || stateWrites != 0 || projectionWrites != 0 {
		t.Fatalf("GET-only state HEAD/GET/PUT=%d/%d/%d projectionWrites=%d; want 0/1/0 and zero", stateHeads, stateGets, stateWrites, projectionWrites)
	}

	page := filepath.Join(root, "docs", "artifacts", "report.html")
	if err := os.WriteFile(page, []byte("<title>GET-only change</title><h1>changed</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	probe.resetProbe()
	changed, err := PublishSite(context.Background(), backend, options)
	if err != nil || changed.Outcome != "published" {
		t.Fatalf("GET-only changed publish = %+v, err=%v", changed, err)
	}
	probe.probeMu.Lock()
	stateHeads, stateGets, stateWrites = probe.stateHeads, probe.stateGets, probe.stateWrites
	probe.probeMu.Unlock()
	if stateHeads != 0 || stateGets != 1 || stateWrites != 1 {
		t.Fatalf("GET-only changed state HEAD/GET/PUT=%d/%d/%d; want 0/1/1", stateHeads, stateGets, stateWrites)
	}
}

func TestPublishSiteChangedStateETagBetweenHeadAndGetFailsBeforeProjectionWrites(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	if _, err := PublishSite(context.Background(), backend, options); err != nil {
		t.Fatal(err)
	}
	before := sitePublishProjectionBytes(backend.lockMemoryBackend, "sre")
	page := filepath.Join(root, "docs", "artifacts", "report.html")
	if err := os.WriteFile(page, []byte("<title>changed</title><h1>Changed</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	backend.resetProbe()
	backend.mismatchStateGetETag = true
	_, err := PublishSite(context.Background(), backend, options)
	if err == nil || !strings.Contains(err.Error(), "changed between HEAD and GET") {
		t.Fatalf("PublishSite() error = %v, want state HEAD/GET mismatch", err)
	}
	backend.probeMu.Lock()
	stateGets, stateWrites := backend.stateGets, backend.stateWrites
	backend.probeMu.Unlock()
	if stateGets != 1 || stateWrites != 0 {
		t.Fatalf("state GET/writes = %d/%d, want one read and no write", stateGets, stateWrites)
	}
	if after := sitePublishProjectionBytes(backend.lockMemoryBackend, "sre"); !equalProjectionBytes(before, after) {
		t.Fatal("projection changed after the state HEAD/GET ETag mismatch")
	}
}

func TestPublishSitePendingJournalCASFailurePreventsProjectionWrites(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	if _, err := PublishSite(context.Background(), backend, options); err != nil {
		t.Fatal(err)
	}
	before := sitePublishProjectionBytes(backend.lockMemoryBackend, "sre")
	page := filepath.Join(root, "docs", "artifacts", "report.html")
	if err := os.WriteFile(page, []byte("<title>pending failure</title><h1>Pending failure</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	backend.resetProbe()
	backend.failJournalWriteAt = 1
	_, err := PublishSite(context.Background(), backend, options)
	if err == nil || !strings.Contains(err.Error(), "save site cache retry record") {
		t.Fatalf("PublishSite() error = %v, want pending journal CAS failure", err)
	}
	backend.probeMu.Lock()
	stateWrites, journalWrites := backend.stateWrites, backend.journalWrites
	projectionWrites := append([]string(nil), backend.projectionWrites...)
	backend.probeMu.Unlock()
	if stateWrites != 0 || journalWrites != 1 || len(projectionWrites) != 0 {
		t.Fatalf("state/journal writes=%d/%d projection writes=%v, want one failed journal write and no state/origin writes", stateWrites, journalWrites, projectionWrites)
	}
	if after := sitePublishProjectionBytes(backend.lockMemoryBackend, "sre"); !equalProjectionBytes(before, after) {
		t.Fatal("projection changed after pending state CAS failed")
	}
}

func TestPublishSiteFinalStateCASFailureRecoversRevertedTouchedKeys(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	if _, err := PublishSite(context.Background(), backend, options); err != nil {
		t.Fatal(err)
	}
	page := filepath.Join(root, "docs", "artifacts", "report.html")
	committedPage, err := os.ReadFile(page)
	if err != nil {
		t.Fatal(err)
	}
	resourceDir := filepath.Join(root, "docs", "artifacts", "assets")
	introduced := filepath.Join(resourceDir, "introduced-a.css")
	if err := os.MkdirAll(resourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(page, []byte("<title>attempt A</title><h1>Attempt A</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(introduced, []byte("body{--attempt-a:1}"), 0o600); err != nil {
		t.Fatal(err)
	}
	backend.resetProbe()
	backend.failStateWriteAt = 1 // transaction journal succeeds; final commit fails.
	if _, err := PublishSite(context.Background(), backend, options); err == nil || !strings.Contains(err.Error(), "commit site publish state") {
		t.Fatalf("publish with final state CAS failure error = %v", err)
	}
	stateKey := sitePublishStateKey("sre")
	stateObject, _, err := backend.lockMemoryBackend.GetObject(context.Background(), stateKey)
	if err != nil {
		t.Fatal(err)
	}
	stateInfo, err := backend.lockMemoryBackend.HeadObject(context.Background(), stateKey)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := decodeSitePublishState("sre", stateInfo, stateObject.Bytes)
	if err != nil || pending.SchemaVersion != sitePublishStateSchemaVersion || pending.Pending != nil {
		t.Fatalf("state after final CAS failure = %+v, err=%v; want unchanged committed v2 state", pending, err)
	}
	journal, _, err := readSiteCacheRetry(context.Background(), backend, "sre")
	if err != nil || journal.Transaction == nil || len(journal.Transaction.TouchedKeys) == 0 {
		t.Fatalf("journal after final CAS failure = %+v, err=%v; want durable touched-key intent", journal, err)
	}

	// Revert a touched page, remove an object introduced by the failed run,
	// and add a different latest object. Recovery must apply the union of old
	// uncertainty and the latest diff, even when a touched key now equals the
	// previously committed bytes.
	if err := os.WriteFile(page, committedPage, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(introduced); err != nil {
		t.Fatal(err)
	}
	latest := filepath.Join(resourceDir, "latest-b.css")
	if err := os.WriteFile(latest, []byte("body{--latest-b:1}"), 0o600); err != nil {
		t.Fatal(err)
	}
	backend.resetProbe()
	result, err := PublishSite(context.Background(), backend, options)
	if err != nil {
		t.Fatalf("retry with latest source error = %v", err)
	}
	if result.Outcome != "published" || !sitePublishHasChange(result.Changes, "update", "_artifacts/sre/report.html") ||
		!sitePublishHasChange(result.Changes, "remove", "_artifacts/sre/assets/introduced-a.css") ||
		!sitePublishHasChange(result.Changes, "create", "_artifacts/sre/assets/latest-b.css") {
		t.Fatalf("latest retry changes = %+v, want forced revert, removal, and latest addition", result.Changes)
	}
	for _, path := range []string{"/_artifacts/sre/report.html", "/_artifacts/sre/assets/introduced-a.css", "/_artifacts/sre/assets/latest-b.css"} {
		if !containsString(result.InvalidationPaths, path) {
			t.Errorf("retry invalidation paths omit uncertain/latest key %s: %v", path, result.InvalidationPaths)
		}
	}
	if got := backend.objectBytes("_artifacts/sre/report.html"); got != string(committedPage) {
		t.Errorf("recovered report bytes = %q, want committed source", got)
	}
	if got := backend.objectBytes("_artifacts/sre/assets/latest-b.css"); got != "body{--latest-b:1}" {
		t.Errorf("latest resource bytes = %q", got)
	}
	if _, exists := backend.lockMemoryBackend.objects["_artifacts/sre/assets/introduced-a.css"]; exists {
		t.Error("object introduced by failed run remains after latest-source recovery")
	}
	finalObject, _, err := backend.lockMemoryBackend.GetObject(context.Background(), stateKey)
	if err != nil {
		t.Fatal(err)
	}
	finalInfo, err := backend.lockMemoryBackend.HeadObject(context.Background(), stateKey)
	if err != nil {
		t.Fatal(err)
	}
	finalState, err := decodeSitePublishState("sre", finalInfo, finalObject.Bytes)
	if err != nil || finalState.Pending != nil {
		t.Fatalf("final state = %+v, err=%v; want committed state without pending journal", finalState, err)
	}
	if _, _, err := backend.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Errorf("cache retry record after successful recovery = %v, want cleared", err)
	}
}

func sitePublishProjectionBytes(backend *lockMemoryBackend, siteID string) map[string]string {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	result := make(map[string]string)
	for key, object := range backend.objects {
		if strings.HasPrefix(key, "_artifacts/"+siteID+"/") || strings.HasPrefix(key, "_indexes/"+siteID+"/") {
			result[key] = string(object.Bytes)
		}
	}
	return result
}

func equalProjectionBytes(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for key, value := range left {
		if right[key] != value {
			return false
		}
	}
	return true
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func sitePublishHasChange(changes []Change, action, path string) bool {
	for _, change := range changes {
		if change.Action == action && change.Path == path {
			return true
		}
	}
	return false
}
