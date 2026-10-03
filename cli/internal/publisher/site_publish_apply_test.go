package publisher

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestApplySitePlanUsesBoundedUploadsAndStrictReferenceBarriers(t *testing.T) {
	const sourceCount, searchCount = 10, 2
	backend := newSitePublishPhaseBarrierBackend(sourceCount, searchCount)
	desired := make([]desiredSiteObject, 0, sourceCount+searchCount+3)
	changes := make([]Change, 0, cap(desired))
	for index := range sourceCount {
		key := fmt.Sprintf("_artifacts/sre/source-%02d.html", index)
		desired = append(desired, testDesiredSiteObject(key))
		changes = append(changes, Change{Action: "update", Path: key})
	}
	for index := range searchCount {
		key := fmt.Sprintf("_indexes/sre/search/%02d.json.gz", index)
		desired = append(desired, testDesiredSiteObject(key))
		changes = append(changes, Change{Action: "create", Path: key})
	}
	serialKeys := []string{
		"_indexes/sre/index.json",
		"_indexes/sre/search/manifest.json",
		"_indexes/sre/meta.json",
	}
	for _, key := range serialKeys {
		desired = append(desired, testDesiredSiteObject(key))
		changes = append(changes, Change{Action: "update", Path: key})
	}
	sharedMetadata := map[string]string{"artifact-pages-site": "sre"}
	for index := range desired {
		desired[index].object.Metadata = sharedMetadata
	}

	type result struct {
		published int
		removed   int
		err       error
	}
	done := make(chan result, 1)
	go func() {
		published, removed, err := applySitePlan(context.Background(), backend, desired, changes, []string{"_artifacts/sre/stale.html"})
		done <- result{published: published, removed: removed, err: err}
	}()

	for range sitePublishPutConcurrency {
		waitForStringEvent(t, backend.sourceStarted, "source upload start")
	}
	select {
	case key := <-backend.searchStarted:
		t.Fatalf("search blob %s started before the source barrier opened", key)
	default:
	}
	close(backend.sourceGate)
	for range sourceCount {
		waitForDoneEvent(t, backend.sourceCompleted, "source upload completion")
	}
	for range searchCount {
		waitForStringEvent(t, backend.searchStarted, "search blob upload start")
	}
	select {
	case key := <-backend.serialStarted:
		t.Fatalf("serial index object %s started before the search-blob barrier opened", key)
	default:
	}
	close(backend.searchGate)
	for range searchCount {
		waitForDoneEvent(t, backend.searchCompleted, "search blob upload completion")
	}
	for _, expected := range serialKeys {
		if got := waitForStringEvent(t, backend.serialStarted, "serial index upload"); got != expected {
			t.Fatalf("serial index upload %q, want %q", got, expected)
		}
	}

	select {
	case result := <-done:
		if result.err != nil || result.published != sourceCount+searchCount+len(serialKeys) || result.removed != 1 {
			t.Fatalf("applySitePlan() = %+v, want all puts and one stale removal", result)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("applySitePlan() did not finish after all barriers opened")
	}
	backend.mu.Lock()
	maxSource, maxSearch := backend.maxSourceActive, backend.maxSearchActive
	violations := append([]string(nil), backend.violations...)
	putsAtDelete := backend.putsAtDelete
	metadataIsolated := backend.metadataIsolated
	successfulPuts := backend.successfulPuts
	backend.mu.Unlock()
	if maxSource != sitePublishPutConcurrency || maxSource > sitePublishPutConcurrency || maxSearch > sitePublishPutConcurrency {
		t.Errorf("peak source/search PUT concurrency = %d/%d, want source phase to reach but never exceed %d", maxSource, maxSearch, sitePublishPutConcurrency)
	}
	if len(violations) != 0 {
		t.Errorf("phase-order violations: %v", violations)
	}
	if successfulPuts != sourceCount+searchCount+len(serialKeys) || putsAtDelete != successfulPuts {
		t.Errorf("successful PUTs before stale deletion = %d/%d, want %d", putsAtDelete, successfulPuts, sourceCount+searchCount+len(serialKeys))
	}
	if !metadataIsolated || sharedMetadata["backend-observed-key"] != "" {
		t.Error("backend metadata mutation leaked across concurrently uploaded objects")
	}
}

func TestApplySitePlanKeepsFirstFailureAndJoinsInflightUploads(t *testing.T) {
	backend := newSitePublishDrainBackend()
	desired := []desiredSiteObject{testDesiredSiteObject("_artifacts/sre/fail.html")}
	for index := range 7 {
		desired = append(desired, testDesiredSiteObject(fmt.Sprintf("_artifacts/sre/blocked-%02d.html", index)))
	}
	desired = append(desired,
		testDesiredSiteObject("_artifacts/sre/queued.html"),
		// This must not start because a source phase failure blocks the index phase.
		testDesiredSiteObject("_indexes/sre/index.json"),
	)
	changes := make([]Change, 0, len(desired))
	for _, object := range desired {
		changes = append(changes, Change{Action: "update", Path: object.key})
	}
	type result struct {
		err error
	}
	done := make(chan result, 1)
	go func() {
		_, _, err := applySitePlan(context.Background(), backend, desired, changes, []string{"_artifacts/sre/stale.html"})
		done <- result{err: err}
	}()
	waitForDoneEvent(t, backend.blockedStarted, "deliberately blocked in-flight upload")
	select {
	case result := <-done:
		t.Fatalf("applySitePlan() returned before blocked request drained: %v", result.err)
	case <-time.After(50 * time.Millisecond):
	}
	close(backend.releaseBlocked)
	select {
	case result := <-done:
		if !errors.Is(result.err, backend.failure) {
			t.Fatalf("applySitePlan() error = %v, want original upload error %v", result.err, backend.failure)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("applySitePlan() did not join and return after the blocked request drained")
	}
	backend.mu.Lock()
	queuedStarted, indexStarted, deletes := backend.queuedStarted, backend.indexStarted, backend.deleteCalls
	backend.mu.Unlock()
	if queuedStarted || indexStarted || deletes != 0 {
		t.Errorf("queued/index/delete after first source failure = %t/%t/%d, want no later phase", queuedStarted, indexStarted, deletes)
	}
}

func TestApplySitePlanParentCancellationJoinsInflightUploads(t *testing.T) {
	backend := newSitePublishCancelBackend()
	desired := []desiredSiteObject{
		testDesiredSiteObject("_artifacts/sre/one.html"),
		testDesiredSiteObject("_artifacts/sre/two.html"),
	}
	changes := []Change{{Action: "update", Path: desired[0].key}, {Action: "update", Path: desired[1].key}}
	ctx, cancel := context.WithCancel(context.Background())
	type result struct{ err error }
	done := make(chan result, 1)
	go func() {
		_, _, err := applySitePlan(ctx, backend, desired, changes, nil)
		done <- result{err: err}
	}()
	for range len(desired) {
		waitForStringEvent(t, backend.started, "cancellation-test PUT start")
	}
	cancel()
	select {
	case result := <-done:
		t.Fatalf("applySitePlan() returned before context-ignoring PUTs finished: %v", result.err)
	case <-time.After(50 * time.Millisecond):
	}
	close(backend.release)
	select {
	case result := <-done:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatalf("applySitePlan() error = %v, want parent context cancellation", result.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("applySitePlan() did not wait for canceled in-flight PUTs")
	}
}

func testDesiredSiteObject(key string) desiredSiteObject {
	return desiredSiteObject{
		key: key, relative: key, data: []byte(key), digest: sha256Hex([]byte(key)),
		object: Object{ContentType: "application/octet-stream", Metadata: map[string]string{"artifact-pages-site": "sre"}},
	}
}

func waitForStringEvent(t *testing.T, events <-chan string, name string) string {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
		return ""
	}
}

func waitForDoneEvent(t *testing.T, events <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-events:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

type sitePublishPhaseBarrierBackend struct {
	mu                sync.Mutex
	sourceExpected    int
	searchExpected    int
	sourceGate        chan struct{}
	searchGate        chan struct{}
	sourceStarted     chan string
	sourceCompleted   chan struct{}
	searchStarted     chan string
	searchCompleted   chan struct{}
	serialStarted     chan string
	sourceActive      int
	searchActive      int
	maxSourceActive   int
	maxSearchActive   int
	sourcesCompleted  int
	searchesCompleted int
	putsAtDelete      int
	metadataIsolated  bool
	successfulPuts    int
	violations        []string
}

func newSitePublishPhaseBarrierBackend(sourceCount, searchCount int) *sitePublishPhaseBarrierBackend {
	return &sitePublishPhaseBarrierBackend{
		sourceExpected: sourceCount, searchExpected: searchCount,
		sourceGate: make(chan struct{}), searchGate: make(chan struct{}),
		sourceStarted: make(chan string, sourceCount), sourceCompleted: make(chan struct{}, sourceCount),
		searchStarted: make(chan string, searchCount), searchCompleted: make(chan struct{}, searchCount),
		serialStarted: make(chan string, 3), metadataIsolated: true,
	}
}

func (backend *sitePublishPhaseBarrierBackend) PutObject(_ context.Context, key string, object Object) error {
	backend.mu.Lock()
	if object.Metadata != nil {
		if _, alreadyObserved := object.Metadata["backend-observed-key"]; alreadyObserved {
			backend.metadataIsolated = false
		}
		object.Metadata["backend-observed-key"] = key
	}
	backend.mu.Unlock()
	switch {
	case strings.HasPrefix(key, "_artifacts/sre/"):
		backend.mu.Lock()
		backend.sourceActive++
		if backend.sourceActive > backend.maxSourceActive {
			backend.maxSourceActive = backend.sourceActive
		}
		backend.mu.Unlock()
		backend.sourceStarted <- key
		<-backend.sourceGate
		backend.mu.Lock()
		backend.sourceActive--
		backend.sourcesCompleted++
		backend.successfulPuts++
		backend.mu.Unlock()
		backend.sourceCompleted <- struct{}{}
	case strings.HasPrefix(key, "_indexes/sre/search/") && strings.HasSuffix(key, ".gz"):
		backend.mu.Lock()
		if backend.sourcesCompleted != backend.sourceExpected {
			backend.violations = append(backend.violations, fmt.Sprintf("search key %s started after only %d/%d source completions", key, backend.sourcesCompleted, backend.sourceExpected))
		}
		backend.searchActive++
		if backend.searchActive > backend.maxSearchActive {
			backend.maxSearchActive = backend.searchActive
		}
		backend.mu.Unlock()
		backend.searchStarted <- key
		<-backend.searchGate
		backend.mu.Lock()
		backend.searchActive--
		backend.searchesCompleted++
		backend.successfulPuts++
		backend.mu.Unlock()
		backend.searchCompleted <- struct{}{}
	default:
		backend.mu.Lock()
		if backend.sourcesCompleted != backend.sourceExpected || backend.searchesCompleted != backend.searchExpected {
			backend.violations = append(backend.violations, fmt.Sprintf("serial key %s started before upload barriers", key))
		}
		backend.successfulPuts++
		backend.mu.Unlock()
		backend.serialStarted <- key
	}
	return nil
}

func (backend *sitePublishPhaseBarrierBackend) ListKeys(context.Context, string) ([]string, error) {
	return nil, nil
}

func (backend *sitePublishPhaseBarrierBackend) DeleteObjects(_ context.Context, keys []string) error {
	backend.mu.Lock()
	backend.putsAtDelete = backend.successfulPuts
	if len(keys) != 1 || keys[0] != "_artifacts/sre/stale.html" {
		backend.violations = append(backend.violations, fmt.Sprintf("unexpected stale keys %v", keys))
	}
	backend.mu.Unlock()
	return nil
}

func (backend *sitePublishPhaseBarrierBackend) Invalidate(context.Context, []string) (string, error) {
	return "", nil
}

type sitePublishDrainBackend struct {
	mu              sync.Mutex
	failure         error
	blockedStarted  chan struct{}
	releaseBlocked  chan struct{}
	blockedExpected int
	blockedCount    int
	blockedOnce     sync.Once
	queuedStarted   bool
	indexStarted    bool
	deleteCalls     int
}

func newSitePublishDrainBackend() *sitePublishDrainBackend {
	return &sitePublishDrainBackend{
		failure: errors.New("injected first source upload failure"), blockedExpected: 7,
		blockedStarted: make(chan struct{}), releaseBlocked: make(chan struct{}),
	}
}

func (backend *sitePublishDrainBackend) PutObject(_ context.Context, key string, _ Object) error {
	switch {
	case key == "_artifacts/sre/fail.html":
		<-backend.blockedStarted
		return backend.failure
	case strings.HasPrefix(key, "_artifacts/sre/blocked-"):
		backend.mu.Lock()
		backend.blockedCount++
		if backend.blockedCount == backend.blockedExpected {
			backend.blockedOnce.Do(func() { close(backend.blockedStarted) })
		}
		backend.mu.Unlock()
		<-backend.releaseBlocked // Deliberately ignores cancellation.
		return nil
	case key == "_artifacts/sre/queued.html":
		backend.mu.Lock()
		backend.queuedStarted = true
		backend.mu.Unlock()
	case key == "_indexes/sre/index.json":
		backend.mu.Lock()
		backend.indexStarted = true
		backend.mu.Unlock()
	}
	return nil
}

func (backend *sitePublishDrainBackend) ListKeys(context.Context, string) ([]string, error) {
	return nil, nil
}

func (backend *sitePublishDrainBackend) DeleteObjects(context.Context, []string) error {
	backend.mu.Lock()
	backend.deleteCalls++
	backend.mu.Unlock()
	return nil
}

func (backend *sitePublishDrainBackend) Invalidate(context.Context, []string) (string, error) {
	return "", nil
}

type sitePublishCancelBackend struct {
	started chan string
	release chan struct{}
}

func newSitePublishCancelBackend() *sitePublishCancelBackend {
	return &sitePublishCancelBackend{started: make(chan string, 2), release: make(chan struct{})}
}

func (backend *sitePublishCancelBackend) PutObject(_ context.Context, key string, _ Object) error {
	backend.started <- key
	<-backend.release // Deliberately ignores cancellation.
	return nil
}

func (backend *sitePublishCancelBackend) ListKeys(context.Context, string) ([]string, error) {
	return nil, nil
}

func (backend *sitePublishCancelBackend) DeleteObjects(context.Context, []string) error { return nil }

func (backend *sitePublishCancelBackend) Invalidate(context.Context, []string) (string, error) {
	return "", nil
}
