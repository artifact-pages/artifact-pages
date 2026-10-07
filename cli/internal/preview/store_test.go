package preview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestValidateBuildResultRejectsMismatchedSiteAndHead(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	const otherSHA = "abcdefabcdefabcdefabcdefabcdefabcdefabcd"
	files := map[string][]byte{"docs/report.md": []byte("# Report\n")}
	documents := []Document{{Path: "docs/report.md", Title: "Report", Format: "markdown"}}
	group := Group{
		ID: "head:" + headSHA, Kind: "manual", HeadSHA: headSHA,
		UpdatedAt: "2026-09-27T00:00:00Z", Documents: documents,
	}
	manifest := RevisionManifest{
		SchemaVersion: SchemaVersion, Site: "sre", HeadSHA: headSHA,
		DefaultHead: "1111111111111111111111111111111111111111", MergeBase: otherSHA,
		CreatedAt: "2026-09-27T00:00:00Z", BundleDigest: digestBundle(files),
		Files: describeFiles(files), Documents: documents,
	}
	base := BuildResult{Site: "sre", Outcome: OutcomePublished, Group: group, Manifest: manifest, Files: files}
	if err := validateBuildResult(base); err != nil {
		t.Fatalf("validateBuildResult(valid) error = %v", err)
	}

	wrongSite := base
	wrongSite.Manifest.Site = "frontend"
	if err := validateBuildResult(wrongSite); err == nil {
		t.Fatal("validateBuildResult accepted a manifest for a different site")
	}

	wrongHead := base
	wrongHead.Group.HeadSHA = otherSHA
	if err := validateBuildResult(wrongHead); err == nil {
		t.Fatal("validateBuildResult accepted a catalog group for a different head")
	}
}

type memoryPreviewStore struct {
	mu             sync.Mutex
	locksMu        sync.Mutex
	locks          map[string]*sync.Mutex
	objects        map[string][]byte
	readFailures   map[string]error
	createFailures map[string]error
	writeFailures  map[string]error
	createCalls    map[string]int
	readCalls      map[string]int
	replaceCalls   map[string]int
	lockCalls      int
	lockDepth      int
	events         []previewStoreEvent
}

type previewStoreEvent struct {
	kind   string
	key    string
	locked bool
}

// concurrentPublishGate ensures both publishers reach the storage boundary
// before either is allowed to enter the underlying same-site lock.
type concurrentPublishGate struct {
	PreviewStore
	mu      sync.Mutex
	entered int
	ready   chan struct{}
}

func (store *concurrentPublishGate) WithSiteLock(ctx context.Context, site string, operation func(context.Context) error) error {
	store.mu.Lock()
	store.entered++
	if store.entered == 2 {
		close(store.ready)
	}
	ready := store.ready
	store.mu.Unlock()

	select {
	case <-ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	return store.PreviewStore.WithSiteLock(ctx, site, operation)
}

func newMemoryPreviewStore() *memoryPreviewStore {
	return &memoryPreviewStore{
		locks:          make(map[string]*sync.Mutex),
		objects:        make(map[string][]byte),
		readFailures:   make(map[string]error),
		createFailures: make(map[string]error),
		writeFailures:  make(map[string]error),
		createCalls:    make(map[string]int),
		readCalls:      make(map[string]int),
		replaceCalls:   make(map[string]int),
	}
}

func (store *memoryPreviewStore) WithSiteLock(ctx context.Context, site string, operation func(context.Context) error) error {
	store.locksMu.Lock()
	lock := store.locks[site]
	if lock == nil {
		lock = &sync.Mutex{}
		store.locks[site] = lock
	}
	store.locksMu.Unlock()
	lock.Lock()
	store.mu.Lock()
	store.lockCalls++
	store.lockDepth++
	store.events = append(store.events, previewStoreEvent{kind: "lock", key: site, locked: true})
	store.mu.Unlock()
	defer func() {
		store.mu.Lock()
		store.lockDepth--
		store.events = append(store.events, previewStoreEvent{kind: "unlock", key: site, locked: false})
		store.mu.Unlock()
		lock.Unlock()
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	return operation(ctx)
}

func (store *memoryPreviewStore) ReadObject(ctx context.Context, key string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.readCalls[key]++
	store.events = append(store.events, previewStoreEvent{kind: "read", key: key, locked: store.lockDepth > 0})
	if err := store.readFailures[key]; err != nil {
		return nil, err
	}
	contents, exists := store.objects[key]
	if !exists {
		return nil, ErrObjectNotFound
	}
	return bytes.Clone(contents), nil
}

func (store *memoryPreviewStore) CreateImmutableObject(ctx context.Context, key string, contents []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.createCalls[key]++
	store.events = append(store.events, previewStoreEvent{kind: "create", key: key, locked: store.lockDepth > 0})
	if err := store.createFailures[key]; err != nil {
		return err
	}
	if existing, exists := store.objects[key]; exists {
		if !bytes.Equal(existing, contents) {
			return ErrImmutableObjectConflict
		}
		return nil
	}
	store.objects[key] = bytes.Clone(contents)
	return nil
}

func (store *memoryPreviewStore) ReplaceMutableObject(ctx context.Context, key string, contents []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	store.replaceCalls[key]++
	store.events = append(store.events, previewStoreEvent{kind: "replace", key: key, locked: store.lockDepth > 0})
	if err := store.writeFailures[key]; err != nil {
		return err
	}
	store.objects[key] = bytes.Clone(contents)
	return nil
}

func (store *memoryPreviewStore) deleteObject(key string) {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.objects, key)
}

func (store *memoryPreviewStore) setReadFailure(key string, err error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.readFailures[key] = err
}

func (store *memoryPreviewStore) setCreateFailure(key string, err error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.createFailures[key] = err
}

func (store *memoryPreviewStore) setWriteFailure(key string, err error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.writeFailures[key] = err
}

func (store *memoryPreviewStore) createCallCount(key string) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.createCalls[key]
}

func (store *memoryPreviewStore) readCallCount(key string) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.readCalls[key]
}

func (store *memoryPreviewStore) replaceCallCount(key string) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.replaceCalls[key]
}

func (store *memoryPreviewStore) eventSnapshot() []previewStoreEvent {
	store.mu.Lock()
	defer store.mu.Unlock()
	return append([]previewStoreEvent(nil), store.events...)
}

func (store *memoryPreviewStore) lockedCallCount() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.lockCalls
}

func testPreviewResult(site, prNumber, headSHA string) BuildResult {
	files := map[string][]byte{
		"assets/report.css": []byte("body { color: #123; }\n"),
		"docs/report.md":    []byte("# Report\n"),
	}
	documents := []Document{{Path: "docs/report.md", Title: "Report", Format: "markdown"}}
	group := Group{
		ID: "pr:" + prNumber, Kind: "pull-request", HeadSHA: headSHA,
		PRURL:     fmt.Sprintf("https://github.com/acme/%s/pull/%s", site, prNumber),
		UpdatedAt: "2026-09-27T00:00:00Z", Documents: documents,
	}
	manifest := RevisionManifest{
		SchemaVersion: SchemaVersion, Site: site, HeadSHA: headSHA,
		DefaultHead: "1111111111111111111111111111111111111111",
		MergeBase:   "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
		CreatedAt:   "2026-09-27T00:00:00Z", BundleDigest: digestBundle(files),
		Files: describeFiles(files), Documents: documents,
	}
	return BuildResult{Site: site, Outcome: OutcomePublished, Group: group, Manifest: manifest, Files: files}
}

func TestPlanPublicationIsReadOnlyAndMatchesTheNextPublish(t *testing.T) {
	store := newMemoryPreviewStore()
	result := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	plan, err := PlanPublication(context.Background(), store, result)
	if err != nil {
		t.Fatalf("PlanPublication() error = %v", err)
	}
	if plan.Outcome != OutcomePublished || len(plan.Objects) != 3 || plan.Objects[0] != (PublicationObjectChange{Action: "create", Path: "assets/report.css", ContentType: "text/css; charset=utf-8"}) || plan.Objects[1].Path != "docs/report.md" || plan.Objects[2].Path != "manifest.json" {
		t.Fatalf("initial PublicationPlan = %+v", plan)
	}
	if !reflect.DeepEqual(plan.CatalogChanges, []PublicationCatalogChange{{Action: "create", GroupID: result.Group.ID, HeadSHA: result.Group.HeadSHA}}) {
		t.Fatalf("initial catalog plan = %+v", plan.CatalogChanges)
	}
	if got := store.lockedCallCount(); got != 0 {
		t.Fatalf("read-only PlanPublication acquired the site lock %d times", got)
	}
	store.mu.Lock()
	if len(store.objects) != 0 {
		store.mu.Unlock()
		t.Fatalf("read-only plan created %d objects", len(store.objects))
	}
	store.mu.Unlock()

	if err := Publish(context.Background(), store, result); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	if got := store.lockedCallCount(); got != 1 {
		t.Fatalf("Publish() site lock calls = %d, want 1", got)
	}
	catalogKey, _ := CatalogKey("project")
	catalogBefore, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatal(err)
	}
	store.mu.Lock()
	createCallsBefore := make(map[string]int, len(store.createCalls))
	for key, count := range store.createCalls {
		createCallsBefore[key] = count
	}
	store.mu.Unlock()

	retryPlan, err := PlanPublication(context.Background(), store, result)
	if err != nil {
		t.Fatalf("same-head PlanPublication() error = %v", err)
	}
	if len(retryPlan.CatalogChanges) != 0 {
		t.Fatalf("same-head catalog plan = %+v, want no changes", retryPlan.CatalogChanges)
	}
	for _, object := range retryPlan.Objects {
		if object.Action != "retain" {
			t.Errorf("same-head object plan = %+v, want every object retained", retryPlan.Objects)
			break
		}
	}
	if err := Publish(context.Background(), store, result); err != nil {
		t.Fatalf("same-head Publish() error = %v", err)
	}
	if got := store.lockedCallCount(); got != 2 {
		t.Fatalf("same-head Publish() site lock calls = %d, want 2 total", got)
	}
	catalogAfter, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil || !bytes.Equal(catalogBefore, catalogAfter) {
		t.Fatalf("same-head publish rewrote an unchanged catalog: equal=%t err=%v", bytes.Equal(catalogBefore, catalogAfter), err)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if !reflect.DeepEqual(store.createCalls, createCallsBefore) {
		t.Fatalf("same-head publish re-created immutable objects: before=%v after=%v", createCallsBefore, store.createCalls)
	}
}

func TestPublishAppliesFreshLockedPlanWithoutDuplicateTargetReads(t *testing.T) {
	store := newMemoryPreviewStore()
	result := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	catalogKey, _ := CatalogKey(result.Site)
	manifestKey, _ := ManifestKey(result.Site, result.Manifest.HeadSHA)
	fileKeys := make(map[string]string, len(result.Files))
	paths := make([]string, 0, len(result.Files))
	for filePath := range result.Files {
		key, err := FileKey(result.Site, result.Manifest.HeadSHA, filePath)
		if err != nil {
			t.Fatal(err)
		}
		fileKeys[filePath] = key
		paths = append(paths, filePath)
	}
	sort.Strings(paths)

	eventStart := len(store.eventSnapshot())
	plan, err := PublishWithPlan(context.Background(), store, result)
	if err != nil {
		t.Fatalf("initial PublishWithPlan() error = %v", err)
	}
	if len(plan.Objects) != len(paths)+1 || plan.Objects[len(plan.Objects)-1].Path != "manifest.json" {
		t.Fatalf("applied object plan = %+v; want files followed by manifest", plan.Objects)
	}
	if got := store.readCallCount(catalogKey); got != 1 {
		t.Errorf("initial catalog origin reads = %d, want 1", got)
	}
	if got := store.readCallCount(manifestKey); got != 1 {
		t.Errorf("initial manifest origin reads = %d, want 1", got)
	}
	for _, filePath := range paths {
		if got := store.readCallCount(fileKeys[filePath]); got != 1 {
			t.Errorf("initial file %q origin reads = %d, want 1", filePath, got)
		}
	}
	var writes []string
	for _, event := range store.eventSnapshot()[eventStart:] {
		if event.kind == "create" || event.kind == "replace" {
			if !event.locked {
				t.Errorf("publication write %s %q occurred outside the site lock", event.kind, event.key)
			}
			writes = append(writes, event.kind+":"+event.key)
		}
		if event.kind == "read" && !event.locked {
			t.Errorf("publication origin read %q occurred outside the site lock", event.key)
		}
	}
	wantWrites := make([]string, 0, len(paths)+2)
	for _, filePath := range paths {
		wantWrites = append(wantWrites, "create:"+fileKeys[filePath])
	}
	wantWrites = append(wantWrites, "create:"+manifestKey, "replace:"+catalogKey)
	if !reflect.DeepEqual(writes, wantWrites) {
		t.Errorf("publication write order = %v; want files, manifest, then catalog: %v", writes, wantWrites)
	}

	// A same-head plan sees the manifest once while pruning the catalog, then
	// reuses that observation for revision validation. Every file is still read
	// and compared byte-for-byte before the plan retains it.
	readCountsBefore := map[string]int{catalogKey: store.readCallCount(catalogKey), manifestKey: store.readCallCount(manifestKey)}
	for _, key := range fileKeys {
		readCountsBefore[key] = store.readCallCount(key)
	}
	createCallsBefore := make(map[string]int, len(paths)+1)
	for _, key := range fileKeys {
		createCallsBefore[key] = store.createCallCount(key)
	}
	createCallsBefore[manifestKey] = store.createCallCount(manifestKey)
	replaceCallsBefore := store.replaceCallCount(catalogKey)

	retryPlan, err := PublishWithPlan(context.Background(), store, result)
	if err != nil {
		t.Fatalf("same-head PublishWithPlan() error = %v", err)
	}
	if len(retryPlan.CatalogChanges) != 0 {
		t.Errorf("same-head catalog changes = %+v; want none", retryPlan.CatalogChanges)
	}
	for _, object := range retryPlan.Objects {
		if object.Action != "retain" {
			t.Errorf("same-head object plan = %+v; want every immutable object retained", retryPlan.Objects)
			break
		}
	}
	if got := store.readCallCount(catalogKey) - readCountsBefore[catalogKey]; got != 1 {
		t.Errorf("same-head catalog origin reads = %d, want 1", got)
	}
	if got := store.readCallCount(manifestKey) - readCountsBefore[manifestKey]; got != 1 {
		t.Errorf("same-head manifest origin reads = %d, want 1 across pruning and revision checks", got)
	}
	for _, key := range fileKeys {
		if got := store.readCallCount(key) - readCountsBefore[key]; got != 1 {
			t.Errorf("same-head file %q origin reads = %d, want 1 full-byte verification", key, got)
		}
		if got := store.createCallCount(key); got != createCallsBefore[key] {
			t.Errorf("same-head publish attempted to recreate file %q", key)
		}
	}
	if got := store.createCallCount(manifestKey); got != createCallsBefore[manifestKey] {
		t.Errorf("same-head publish attempted to recreate the manifest")
	}
	if got := store.replaceCallCount(catalogKey); got != replaceCallsBefore {
		t.Errorf("same-head publish rewrote an unchanged catalog")
	}
}

func TestPublishAllowsBundleFileNamedManifestJSON(t *testing.T) {
	store := newMemoryPreviewStore()
	result := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	result.Files["manifest.json"] = []byte("this is a source bundle file\n")
	result.Manifest.Files = describeFiles(result.Files)
	result.Manifest.BundleDigest = digestBundle(result.Files)
	if err := Publish(context.Background(), store, result); err != nil {
		t.Fatalf("Publish() with a root manifest.json source file error = %v", err)
	}
	fileKey, err := FileKey(result.Site, result.Manifest.HeadSHA, "manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	fileBytes, err := store.ReadObject(context.Background(), fileKey)
	if err != nil || !bytes.Equal(fileBytes, result.Files["manifest.json"]) {
		t.Fatalf("root manifest.json bundle bytes = %q, err=%v", fileBytes, err)
	}
	manifestKey, err := ManifestKey(result.Site, result.Manifest.HeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := store.ReadObject(context.Background(), manifestKey)
	if err != nil {
		t.Fatalf("read completion manifest: %v", err)
	}
	manifest, err := DecodeManifest(manifestBytes)
	if err != nil || !sameImmutableProjection(manifest, result.Manifest) {
		t.Fatalf("completion manifest = %+v, err=%v", manifest, err)
	}
}

func TestPlanPublicationReportsDeletionOnlyCatalogRemovalWithoutWrites(t *testing.T) {
	store := newMemoryPreviewStore()
	published := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	if err := Publish(context.Background(), store, published); err != nil {
		t.Fatal(err)
	}
	deletion := BuildResult{Site: published.Site, Outcome: OutcomeNoPreview, Group: published.Group}
	plan, err := PlanPublication(context.Background(), store, deletion)
	if err != nil {
		t.Fatalf("PlanPublication(no-preview) error = %v", err)
	}
	if plan.Outcome != OutcomeNoPreview || len(plan.Objects) != 0 || !reflect.DeepEqual(plan.CatalogChanges, []PublicationCatalogChange{{
		Action: "remove", GroupID: published.Group.ID, HeadSHA: published.Group.HeadSHA, Reason: "no-previewable-documents",
	}}) {
		t.Fatalf("deletion-only plan = %+v", plan)
	}
	if len(readTestCatalog(t, store, "project").Groups) != 1 {
		t.Fatal("read-only deletion plan changed the catalog")
	}
}

func TestPlanPublicationSortsCatalogChangesIndependentOfExistingCatalogOrder(t *testing.T) {
	store := newMemoryPreviewStore()
	staleFirst := testPreviewResult("project", "10", "2222222222222222222222222222222222222222")
	currentOld := testPreviewResult("project", "50", "1111111111111111111111111111111111111111")
	staleLast := testPreviewResult("project", "90", "3333333333333333333333333333333333333333")
	current := testPreviewResult("project", "50", "ffffffffffffffffffffffffffffffffffffffff")
	catalog := Catalog{
		SchemaVersion: SchemaVersion,
		Site:          "project",
		Groups:        []Group{staleLast.Group, currentOld.Group, staleFirst.Group},
		RevisionHistory: []GroupRevisionHistory{
			{GroupID: staleFirst.Group.ID, Revisions: []RevisionOwnership{{HeadSHA: staleFirst.Group.HeadSHA, Files: []string{}}}},
			{GroupID: currentOld.Group.ID, Revisions: []RevisionOwnership{{HeadSHA: currentOld.Group.HeadSHA, Files: []string{}}}},
			{GroupID: staleLast.Group.ID, Revisions: []RevisionOwnership{{HeadSHA: staleLast.Group.HeadSHA, Files: []string{}}}},
		},
	}
	catalogBytes, err := EncodeCatalog(catalog)
	if err != nil {
		t.Fatalf("EncodeCatalog() error = %v", err)
	}
	catalogKey, err := CatalogKey("project")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ReplaceMutableObject(context.Background(), catalogKey, catalogBytes); err != nil {
		t.Fatal(err)
	}

	plan, err := PlanPublication(context.Background(), store, current)
	if err != nil {
		t.Fatalf("PlanPublication() error = %v", err)
	}
	want := []PublicationCatalogChange{
		{Action: "remove", GroupID: "pr:10", HeadSHA: staleFirst.Group.HeadSHA, Reason: "manifest-missing"},
		{Action: "remove", GroupID: "pr:50", HeadSHA: currentOld.Group.HeadSHA, Reason: "manifest-missing"},
		{Action: "create", GroupID: "pr:50", HeadSHA: current.Group.HeadSHA},
		{Action: "remove", GroupID: "pr:90", HeadSHA: staleLast.Group.HeadSHA, Reason: "manifest-missing"},
	}
	if !reflect.DeepEqual(plan.CatalogChanges, want) {
		t.Fatalf("catalog changes = %+v; want stable group/head/action order %+v", plan.CatalogChanges, want)
	}
}

func readTestCatalog(t *testing.T, store PreviewStore, site string) Catalog {
	t.Helper()
	key, err := CatalogKey(site)
	if err != nil {
		t.Fatal(err)
	}
	contents, err := store.ReadObject(context.Background(), key)
	if errors.Is(err, ErrObjectNotFound) {
		return Catalog{SchemaVersion: SchemaVersion, Site: site, Groups: []Group{}, RevisionHistory: []GroupRevisionHistory{}}
	}
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := DecodeCatalog(contents)
	if err != nil {
		t.Fatal(err)
	}
	return catalog
}

func TestPublishSerializesConcurrentGroupsAndNoPreviewRemovesOnlyItsGroup(t *testing.T) {
	store := &concurrentPublishGate{PreviewStore: newMemoryPreviewStore(), ready: make(chan struct{})}
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	results := []BuildResult{testPreviewResult("project", "42", headSHA), testPreviewResult("project", "43", headSHA)}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var wait sync.WaitGroup
	errorsFound := make(chan error, len(results))
	for _, result := range results {
		wait.Add(1)
		go func(result BuildResult) {
			defer wait.Done()
			errorsFound <- Publish(ctx, store, result)
		}(result)
	}
	wait.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatalf("concurrent Publish() error = %v", err)
		}
	}

	catalog := readTestCatalog(t, store, "project")
	if len(catalog.Groups) != 2 || catalog.Groups[0].ID == catalog.Groups[1].ID {
		t.Fatalf("concurrent catalog groups = %#v, want both PR groups", catalog.Groups)
	}

	deletion := BuildResult{Site: "project", Outcome: OutcomeNoPreview, Group: results[0].Group}
	if err := Publish(context.Background(), store, deletion); err != nil {
		t.Fatalf("no-preview Publish() error = %v", err)
	}
	catalog = readTestCatalog(t, store, "project")
	if len(catalog.Groups) != 1 || catalog.Groups[0].ID != results[1].Group.ID {
		t.Fatalf("catalog after deletion = %#v, want only %s", catalog.Groups, results[1].Group.ID)
	}
}

func TestPlanAndReconcileCatalogRetainLiveGroupsAndRemoveOnlyConfirmedMissing(t *testing.T) {
	store := newMemoryPreviewStore()
	missing := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	unavailable := testPreviewResult("project", "43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	live := testPreviewResult("project", "44", "2222222222222222222222222222222222222222")
	otherSite := testPreviewResult("other", "9", "2222222222222222222222222222222222222222")
	for _, result := range []BuildResult{missing, unavailable, live, otherSite} {
		if err := Publish(context.Background(), store, result); err != nil {
			t.Fatal(err)
		}
	}
	missingManifest, _ := ManifestKey("project", missing.Manifest.HeadSHA)
	unavailableManifest, _ := ManifestKey("project", unavailable.Manifest.HeadSHA)
	store.deleteObject(missingManifest)
	store.setReadFailure(unavailableManifest, errors.New("origin unavailable"))

	// Pull-request catalog groups carry no merged/closed state. Reconciliation
	// follows provider availability, retaining live groups regardless of PR state.
	catalogKey, _ := CatalogKey("project")
	beforePlan, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanCatalogReconciliation(context.Background(), store, "project")
	if err != nil {
		t.Fatalf("PlanCatalogReconciliation() error = %v", err)
	}
	wantPlan := CatalogReconciliationPlan{Changes: []CatalogReconciliationChange{
		{Action: "remove", GroupID: missing.Group.ID, HeadSHA: missing.Group.HeadSHA, Reason: catalogManifestMissingReason},
		{Action: "keep", GroupID: unavailable.Group.ID, HeadSHA: unavailable.Group.HeadSHA, Reason: catalogManifestUnavailableReason},
		{Action: "keep", GroupID: live.Group.ID, HeadSHA: live.Group.HeadSHA, Reason: catalogManifestPresentReason},
	}}
	if !reflect.DeepEqual(plan, wantPlan) {
		t.Fatalf("PlanCatalogReconciliation() = %+v, want %+v", plan, wantPlan)
	}
	afterPlan, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil || !bytes.Equal(afterPlan, beforePlan) {
		t.Fatalf("read-only plan changed catalog: bytesEqual=%v err=%v", bytes.Equal(afterPlan, beforePlan), err)
	}

	var appliedPlan CatalogReconciliationPlan
	if err := store.WithSiteLock(context.Background(), "project", func(lockedContext context.Context) error {
		var reconcileErr error
		appliedPlan, reconcileErr = ReconcileCatalogUnderSiteLock(lockedContext, store, "project")
		return reconcileErr
	}); err != nil {
		t.Fatalf("ReconcileCatalogUnderSiteLock() error = %v", err)
	}
	if !reflect.DeepEqual(appliedPlan, wantPlan) {
		t.Fatalf("ReconcileCatalogUnderSiteLock() plan = %+v, want %+v", appliedPlan, wantPlan)
	}
	projectCatalog := readTestCatalog(t, store, "project")
	if len(projectCatalog.Groups) != 2 || projectCatalog.Groups[0].ID != unavailable.Group.ID || projectCatalog.Groups[1].ID != live.Group.ID {
		t.Fatalf("project catalog = %#v, want unavailable and live groups retained", projectCatalog.Groups)
	}
	otherCatalog := readTestCatalog(t, store, "other")
	if len(otherCatalog.Groups) != 1 || otherCatalog.Groups[0].ID != otherSite.Group.ID {
		t.Fatalf("other site catalog changed during reconciliation: %#v", otherCatalog.Groups)
	}
}

func TestPublishFailureAndRetryNeverAdvertiseIncompleteRevision(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	t.Run("partial bundle upload", func(t *testing.T) {
		store := newMemoryPreviewStore()
		result := testPreviewResult("project", "42", headSHA)
		completedFileKey, _ := FileKey("project", headSHA, "assets/report.css")
		failedFileKey, _ := FileKey("project", headSHA, "docs/report.md")
		store.setCreateFailure(failedFileKey, errors.New("injected file upload failure"))
		if err := Publish(context.Background(), store, result); err == nil {
			t.Fatal("Publish() succeeded after an injected file upload failure")
		}
		manifestKey, _ := ManifestKey("project", headSHA)
		if _, err := store.ReadObject(context.Background(), manifestKey); !errors.Is(err, ErrObjectNotFound) {
			t.Fatalf("manifest after partial upload = %v, want confirmed absence", err)
		}
		if len(readTestCatalog(t, store, "project").Groups) != 0 {
			t.Fatal("partial revision became discoverable")
		}
		completedCreateCalls := store.createCallCount(completedFileKey)
		failedCreateCalls := store.createCallCount(failedFileKey)
		manifestCreateCalls := store.createCallCount(manifestKey)
		eventStart := len(store.eventSnapshot())
		store.setCreateFailure(failedFileKey, nil)
		if err := Publish(context.Background(), store, result); err != nil {
			t.Fatalf("retry after partial upload failed: %v", err)
		}
		if got := store.createCallCount(completedFileKey); got != completedCreateCalls {
			t.Errorf("retry recreated completed file: calls=%d before retry=%d", got, completedCreateCalls)
		}
		if got := store.createCallCount(failedFileKey); got != failedCreateCalls+1 {
			t.Errorf("retry create calls for missing file = %d, want %d", got, failedCreateCalls+1)
		}
		if got := store.createCallCount(manifestKey); got != manifestCreateCalls+1 {
			t.Errorf("retry manifest create calls = %d, want %d", got, manifestCreateCalls+1)
		}
		var writes []string
		for _, event := range store.eventSnapshot()[eventStart:] {
			if event.kind == "create" || event.kind == "replace" {
				writes = append(writes, event.kind+":"+event.key)
			}
		}
		catalogKey, _ := CatalogKey("project")
		wantWrites := []string{"create:" + failedFileKey, "create:" + manifestKey, "replace:" + catalogKey}
		if !reflect.DeepEqual(writes, wantWrites) {
			t.Errorf("partial retry write order = %v; want missing file, manifest, then catalog %v", writes, wantWrites)
		}
		if len(readTestCatalog(t, store, "project").Groups) != 1 {
			t.Fatal("successful retry did not advertise the completed revision")
		}
	})

	t.Run("manifest creation failure", func(t *testing.T) {
		store := newMemoryPreviewStore()
		result := testPreviewResult("project", "42", headSHA)
		manifestKey, _ := ManifestKey("project", headSHA)
		store.setCreateFailure(manifestKey, errors.New("injected manifest write failure"))
		if err := Publish(context.Background(), store, result); err == nil {
			t.Fatal("Publish() succeeded after an injected manifest write failure")
		}
		if _, err := store.ReadObject(context.Background(), manifestKey); !errors.Is(err, ErrObjectNotFound) {
			t.Fatalf("manifest after failed completion write = %v, want confirmed absence", err)
		}
		if len(readTestCatalog(t, store, "project").Groups) != 0 {
			t.Fatal("catalog advertised a revision before its manifest was committed")
		}
		store.setCreateFailure(manifestKey, nil)
		if err := Publish(context.Background(), store, result); err != nil {
			t.Fatalf("retry after manifest failure failed: %v", err)
		}
	})

	t.Run("catalog replacement failure", func(t *testing.T) {
		store := newMemoryPreviewStore()
		result := testPreviewResult("project", "42", headSHA)
		catalogKey, _ := CatalogKey("project")
		store.setWriteFailure(catalogKey, errors.New("injected catalog failure"))
		if err := Publish(context.Background(), store, result); err == nil {
			t.Fatal("Publish() succeeded after an injected catalog failure")
		}
		manifestKey, _ := ManifestKey("project", headSHA)
		if _, err := store.ReadObject(context.Background(), manifestKey); err != nil {
			t.Fatalf("completed manifest should exist for retry: %v", err)
		}
		if len(readTestCatalog(t, store, "project").Groups) != 0 {
			t.Fatal("catalog advertised a revision after its write failed")
		}
		createCalls := store.createCallCount(manifestKey)
		store.setWriteFailure(catalogKey, nil)
		if err := Publish(context.Background(), store, result); err != nil {
			t.Fatalf("retry after catalog failure failed: %v", err)
		}
		if got := store.createCallCount(manifestKey); got != createCalls {
			t.Fatalf("same-head retry recreated immutable manifest %d times; before retry %d", got, createCalls)
		}
		if len(readTestCatalog(t, store, "project").Groups) != 1 {
			t.Fatal("retry did not converge the catalog")
		}
	})
}

func TestPublishSameHeadRetryVerifiesImmutableBundleAndDocuments(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	for _, test := range []struct {
		name   string
		mutate func(*BuildResult)
	}{
		{
			name: "changed bytes",
			mutate: func(result *BuildResult) {
				result.Files["docs/report.md"] = []byte("# Changed bytes\n")
				result.Manifest.Files = describeFiles(result.Files)
				result.Manifest.BundleDigest = digestBundle(result.Files)
			},
		},
		{
			name: "changed selected documents",
			mutate: func(result *BuildResult) {
				delete(result.Files, "docs/report.md")
				result.Files["docs/alternative.md"] = []byte("# Alternative\n")
				documents := []Document{{Path: "docs/alternative.md", Title: "Alternative", Format: "markdown"}}
				result.Manifest.Documents = documents
				result.Manifest.Files = describeFiles(result.Files)
				result.Manifest.BundleDigest = digestBundle(result.Files)
				result.Group.Documents = documents
			},
		},
		{
			name: "changed comparison merge-base",
			mutate: func(result *BuildResult) {
				result.Manifest.MergeBase = "2222222222222222222222222222222222222222"
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := newMemoryPreviewStore()
			original := testPreviewResult("project", "42", headSHA)
			if err := Publish(context.Background(), store, original); err != nil {
				t.Fatalf("initial Publish() error = %v", err)
			}
			manifestKey, _ := ManifestKey("project", headSHA)
			manifestBefore, err := store.ReadObject(context.Background(), manifestKey)
			if err != nil {
				t.Fatalf("read original immutable manifest: %v", err)
			}
			fileKey, _ := FileKey("project", headSHA, "docs/report.md")
			fileBefore, err := store.ReadObject(context.Background(), fileKey)
			if err != nil {
				t.Fatalf("read original immutable document: %v", err)
			}

			changed := testPreviewResult("project", "42", headSHA)
			test.mutate(&changed)
			if err := Publish(context.Background(), store, changed); !errors.Is(err, ErrImmutableRevisionMismatch) {
				t.Fatalf("Publish(changed same-head retry) error = %v, want immutable revision mismatch", err)
			}
			manifestAfter, err := store.ReadObject(context.Background(), manifestKey)
			if err != nil || !bytes.Equal(manifestAfter, manifestBefore) {
				t.Fatalf("immutable manifest changed after rejected retry: bytesEqual=%t err=%v", bytes.Equal(manifestAfter, manifestBefore), err)
			}
			fileAfter, err := store.ReadObject(context.Background(), fileKey)
			if err != nil || !bytes.Equal(fileAfter, fileBefore) {
				t.Fatalf("immutable document changed after rejected retry: bytesEqual=%t err=%v", bytes.Equal(fileAfter, fileBefore), err)
			}
			catalog := readTestCatalog(t, store, "project")
			if len(catalog.Groups) != 1 || !reflect.DeepEqual(catalog.Groups[0].Documents, original.Group.Documents) {
				t.Fatalf("catalog after rejected retry = %+v; want the original selected documents", catalog.Groups)
			}
		})
	}
}

func TestRevisionHistoryIsSortedOwnershipSetAndSupportsHeadRevert(t *testing.T) {
	store := newMemoryPreviewStore()
	const first = "1111111111111111111111111111111111111111"
	const second = "2222222222222222222222222222222222222222"
	for _, result := range []BuildResult{
		testPreviewResult("project", "42", first),
		testPreviewResult("project", "42", second),
		testPreviewResult("project", "42", first),
	} {
		if err := Publish(context.Background(), store, result); err != nil {
			t.Fatalf("Publish(head %s) error = %v", result.Group.HeadSHA, err)
		}
	}
	catalog := readTestCatalog(t, store, "project")
	if len(catalog.Groups) != 1 || catalog.Groups[0].HeadSHA != first {
		t.Fatalf("visible group = %+v; want reverted head %s", catalog.Groups, first)
	}
	if len(catalog.RevisionHistory) != 1 || len(catalog.RevisionHistory[0].Revisions) != 2 || catalog.RevisionHistory[0].Revisions[0].HeadSHA != first || catalog.RevisionHistory[0].Revisions[1].HeadSHA != second {
		t.Fatalf("revision ownership history = %+v; want unique SHA-sorted set", catalog.RevisionHistory)
	}
}

func TestPublishRejectsCorruptedExistingBundleOnSameHeadRetry(t *testing.T) {
	result := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	store := newMemoryPreviewStore()
	if err := Publish(context.Background(), store, result); err != nil {
		t.Fatalf("initial Publish() error = %v", err)
	}
	manifestKey, _ := ManifestKey("project", result.Manifest.HeadSHA)
	manifestBefore, err := store.ReadObject(context.Background(), manifestKey)
	if err != nil {
		t.Fatalf("read published manifest: %v", err)
	}
	fileKey, _ := FileKey("project", result.Manifest.HeadSHA, "docs/report.md")
	store.mu.Lock()
	store.objects[fileKey] = []byte("corrupted stored bytes\n")
	store.mu.Unlock()
	catalogKey, _ := CatalogKey("project")
	catalogBefore, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatalf("read published catalog: %v", err)
	}

	err = Publish(context.Background(), store, result)
	if err == nil || !strings.Contains(err.Error(), "differs from its recorded bytes") {
		t.Fatalf("Publish(same-head retry with corrupted stored file) error = %v; want stored-file verification failure", err)
	}
	manifestAfter, err := store.ReadObject(context.Background(), manifestKey)
	if err != nil || !bytes.Equal(manifestAfter, manifestBefore) {
		t.Fatalf("manifest after rejected retry changed: bytesEqual=%t err=%v", bytes.Equal(manifestAfter, manifestBefore), err)
	}
	catalogAfter, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil || !bytes.Equal(catalogAfter, catalogBefore) {
		t.Fatalf("catalog after rejected retry changed: bytesEqual=%t err=%v", bytes.Equal(catalogAfter, catalogBefore), err)
	}
}

func TestPublishUpsertPrunesOnlyConfirmedMissingManifestReferences(t *testing.T) {
	store := newMemoryPreviewStore()
	missing := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	unavailable := testPreviewResult("project", "43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	live := testPreviewResult("project", "44", "2222222222222222222222222222222222222222")
	for _, result := range []BuildResult{missing, unavailable, live} {
		if err := Publish(context.Background(), store, result); err != nil {
			t.Fatalf("Publish(%s) error = %v", result.Group.ID, err)
		}
	}
	missingManifest, _ := ManifestKey("project", missing.Manifest.HeadSHA)
	store.deleteObject(missingManifest)
	unavailableManifest, _ := ManifestKey("project", unavailable.Manifest.HeadSHA)
	store.setReadFailure(unavailableManifest, errors.New("origin unavailable"))

	next := testPreviewResult("project", "45", "3333333333333333333333333333333333333333")
	if err := Publish(context.Background(), store, next); err != nil {
		t.Fatalf("Publish(new group with stale references) error = %v", err)
	}
	catalog := readTestCatalog(t, store, "project")
	ids := make([]string, 0, len(catalog.Groups))
	for _, group := range catalog.Groups {
		ids = append(ids, group.ID)
	}
	want := []string{unavailable.Group.ID, live.Group.ID, next.Group.ID}
	if !reflect.DeepEqual(ids, want) {
		t.Fatalf("catalog after upsert = %v; want unavailable, live, and new groups %v", ids, want)
	}
}

func TestReconcileCatalogIsIdempotentWhenNoManifestIsMissing(t *testing.T) {
	store := newMemoryPreviewStore()
	result := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	if err := Publish(context.Background(), store, result); err != nil {
		t.Fatal(err)
	}
	catalogKey, _ := CatalogKey("project")
	catalogBefore, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := PlanCatalogReconciliation(context.Background(), store, "project")
	if err != nil {
		t.Fatalf("PlanCatalogReconciliation() error = %v", err)
	}
	wantPlan := CatalogReconciliationPlan{Changes: []CatalogReconciliationChange{{
		Action: "keep", GroupID: result.Group.ID, HeadSHA: result.Group.HeadSHA, Reason: catalogManifestPresentReason,
	}}}
	if !reflect.DeepEqual(plan, wantPlan) {
		t.Fatalf("PlanCatalogReconciliation() = %+v, want %+v", plan, wantPlan)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := ReconcileCatalog(context.Background(), store, "project"); err != nil {
			t.Fatalf("ReconcileCatalog() attempt %d error = %v", attempt+1, err)
		}
	}
	actual, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, catalogBefore) {
		t.Fatal("reconciliation rewrote an unchanged catalog")
	}
}

func TestPublishAdvancesOnlyTheNamedCatalogGroup(t *testing.T) {
	store := newMemoryPreviewStore()
	first := testPreviewResult("project", "42", "0123456789abcdef0123456789abcdef01234567")
	second := testPreviewResult("project", "43", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	if err := Publish(context.Background(), store, first); err != nil {
		t.Fatal(err)
	}
	if err := Publish(context.Background(), store, second); err != nil {
		t.Fatal(err)
	}

	nextRevision := testPreviewResult("project", "42", "2222222222222222222222222222222222222222")
	nextRevision.Group.UpdatedAt = "2026-09-28T00:00:00Z"
	if err := Publish(context.Background(), store, nextRevision); err != nil {
		t.Fatal(err)
	}
	catalog := readTestCatalog(t, store, "project")
	if len(catalog.Groups) != 2 {
		t.Fatalf("catalog has %d groups after advance, want 2", len(catalog.Groups))
	}
	for _, group := range catalog.Groups {
		switch group.ID {
		case first.Group.ID:
			if group.HeadSHA != nextRevision.Group.HeadSHA || group.UpdatedAt != nextRevision.Group.UpdatedAt {
				t.Errorf("advanced group = %+v, want latest head and timestamp", group)
			}
		case second.Group.ID:
			if group.HeadSHA != second.Group.HeadSHA {
				t.Errorf("unrelated group head changed to %s", group.HeadSHA)
			}
		default:
			t.Errorf("unexpected catalog group %q", group.ID)
		}
	}
	oldManifestKey, _ := ManifestKey("project", first.Manifest.HeadSHA)
	if _, err := store.ReadObject(context.Background(), oldManifestKey); err != nil {
		t.Fatalf("advancing discovery deleted the old fixed revision: %v", err)
	}
	oldFileKey, _ := FileKey("project", first.Manifest.HeadSHA, "docs/report.md")
	newFileKey, _ := FileKey("project", nextRevision.Manifest.HeadSHA, "docs/report.md")
	if oldFileKey == newFileKey {
		t.Fatal("distinct preview heads resolved to the same immutable file key")
	}
	oldFile, oldErr := store.ReadObject(context.Background(), oldFileKey)
	newFile, newErr := store.ReadObject(context.Background(), newFileKey)
	if oldErr != nil || newErr != nil || !bytes.Equal(oldFile, first.Files["docs/report.md"]) || !bytes.Equal(newFile, nextRevision.Files["docs/report.md"]) {
		t.Fatalf("same-byte distinct-head file revisions were not retained independently: oldErr=%v newErr=%v", oldErr, newErr)
	}
}
