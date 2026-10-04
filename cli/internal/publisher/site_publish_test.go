package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
)

const registeredSREManifest = `schemaVersion: 1
sites:
  sre:
    name: SRE & Platform
    description: Operational reviews and incident reports
    repository: acme/sre
    sourcePath: docs/artifacts
`

const emptySitesManifest = "schemaVersion: 1\nsites: {}\n"

const registeredSREAndDocsManifest = `schemaVersion: 1
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
  sre:
    name: SRE & Platform
    repository: acme/sre
    sourcePath: docs/artifacts
`

const docsOnlyManifest = `schemaVersion: 1
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
`

func TestPublishSiteRequiresExactRegisteredCheckoutBeforeContentWrites(t *testing.T) {
	tests := []struct {
		name             string
		origin           string
		manifest         string
		invalidJSON      []byte
		siteID           string
		sourcePath       string
		outsideSource    bool
		outsideSymlink   bool
		missingRegistry  bool
		wantError        string
		wantRegistryRead bool
	}{
		{name: "unregistered site", origin: "git@github.com:acme/sre.git", manifest: emptySitesManifest, siteID: "sre", sourcePath: "docs/artifacts", wantError: "is not registered", wantRegistryRead: true},
		{name: "renamed site ID", origin: "git@github.com:acme/sre.git", manifest: strings.Replace(registeredSREManifest, "  sre:", "  platform-sre:", 1), siteID: "sre", sourcePath: "docs/artifacts", wantError: "is not registered", wantRegistryRead: true},
		{name: "invalid site ID", origin: "git@github.com:acme/sre.git", manifest: registeredSREManifest, siteID: "../sre", sourcePath: "docs/artifacts", wantError: "invalid site identifier"},
		{name: "renamed repository", origin: "git@github.com:acme/renamed-sre.git", manifest: registeredSREManifest, siteID: "sre", sourcePath: "docs/artifacts", wantError: "registered to acme/sre:docs/artifacts", wantRegistryRead: true},
		{name: "mismatched source path", origin: "git@github.com:acme/sre.git", manifest: registeredSREManifest, siteID: "sre", sourcePath: "docs/other", wantError: "registered to acme/sre:docs/artifacts", wantRegistryRead: true},
		{name: "missing source directory", origin: "git@github.com:acme/sre.git", manifest: registeredSREManifest, siteID: "sre", sourcePath: "docs/missing", wantError: "resolve source directory", wantRegistryRead: true},
		{name: "source outside checkout", origin: "git@github.com:acme/sre.git", manifest: registeredSREManifest, siteID: "sre", outsideSource: true, wantError: "must be inside the Git working tree", wantRegistryRead: true},
		{name: "source symlink outside checkout", origin: "git@github.com:acme/sre.git", manifest: registeredSREManifest, siteID: "sre", outsideSymlink: true, wantError: "must be inside the Git working tree", wantRegistryRead: true},
		{name: "non GitHub origin", origin: "git@gitlab.com:acme/sre.git", manifest: registeredSREManifest, siteID: "sre", sourcePath: "docs/artifacts", wantError: "GitHub owner/repository"},
		{name: "missing deployed registry", origin: "git@github.com:acme/sre.git", siteID: "sre", sourcePath: "docs/artifacts", wantError: "deployed site registry _indexes/sites.json is missing", wantRegistryRead: true, missingRegistry: true},
		{name: "invalid deployed registry", origin: "git@github.com:acme/sre.git", invalidJSON: []byte(`{"schemaVersion":1,"sites":[{"id":"sre","name":"SRE","repository":"acme/sre","sourcePath":"../outside"}]}`), siteID: "sre", sourcePath: "docs/artifacts", wantError: "validate deployed site registry", wantRegistryRead: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := createPublisherCheckout(t, test.origin)
			backend := newSiteUnregisterRaceBackend()
			if test.missingRegistry {
				// Absence is itself the deployed state under test.
			} else if len(test.invalidJSON) > 0 {
				seedMemoryObject(backend.lockMemoryBackend, "_indexes/sites.json", test.invalidJSON)
			} else {
				seedPublisherRegistry(t, backend.lockMemoryBackend, test.manifest)
			}
			sourcePath := test.sourcePath
			if test.outsideSource {
				sourcePath = t.TempDir()
				if err := os.WriteFile(filepath.Join(sourcePath, "outside.html"), []byte("outside"), 0o600); err != nil {
					t.Fatal(err)
				}
			} else if test.outsideSymlink {
				outside := t.TempDir()
				if err := os.WriteFile(filepath.Join(outside, "outside.html"), []byte("outside"), 0o600); err != nil {
					t.Fatal(err)
				}
				sourcePath = filepath.Join(root, "docs", "linked")
				if err := os.Symlink(outside, sourcePath); err != nil {
					t.Fatal(err)
				}
			} else if filepath.IsAbs(sourcePath) {
				t.Fatalf("unexpected absolute fixture source %q", sourcePath)
			}

			_, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: test.siteID, SourceDir: sourcePath})
			if err == nil || !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("PublishSite() error = %v, want substring %q", err, test.wantError)
			}
			assertNoPublishedSiteContent(t, backend.lockMemoryBackend, test.siteID)
			if got := backend.contentMutations.Load(); got != 0 {
				t.Fatalf("ineligible publish performed %d content-plane mutations", got)
			}
			operations := backend.operationSnapshot()
			registryReadIndex, lockAcquireIndex := -1, -1
			for index, operation := range operations {
				if operation == "get:_indexes/sites.json" && registryReadIndex < 0 {
					registryReadIndex = index
				}
				if operation == "lock-held:"+siteLockKey(test.siteID) && lockAcquireIndex < 0 {
					lockAcquireIndex = index
				}
			}
			registryRead := registryReadIndex >= 0
			if registryRead != test.wantRegistryRead {
				t.Fatalf("origin registry read = %t, want %t; operations=%v", registryRead, test.wantRegistryRead, operations)
			}
			if test.wantRegistryRead && (lockAcquireIndex < 0 || registryReadIndex < lockAcquireIndex) {
				t.Fatalf("site lock was not acquired before authoritative registry: %v", operations)
			}
		})
	}
}

func TestPublishSiteRejectsOverlappingLocalSourceAndTargetBeforeLock(t *testing.T) {
	tests := []struct {
		name       string
		sourcePath string
		sourceDir  string
		storage    string
		dryRun     bool
	}{
		{name: "target nested under source", sourcePath: ".", sourceDir: ".", storage: ".local/storage"},
		{name: "target nested under default source", sourcePath: ".", storage: ".local/storage"},
		{name: "source nested under target", sourcePath: "docs/artifacts", sourceDir: "docs/artifacts", storage: "."},
		{name: "same source and target", sourcePath: "docs/artifacts", sourceDir: "docs/artifacts", storage: "docs/artifacts"},
		{name: "dry run target nested under source", sourcePath: ".", sourceDir: ".", storage: ".local/storage", dryRun: true},
		{name: "dry run source nested under target", sourcePath: "docs/artifacts", sourceDir: "docs/artifacts", storage: ".", dryRun: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
			backend, err := NewDirectoryBackend(filepath.Join(root, filepath.FromSlash(test.storage)))
			if err != nil {
				t.Fatal(err)
			}
			manifest := fmt.Sprintf("schemaVersion: 1\nsites:\n  sre:\n    name: SRE\n    repository: acme/sre\n    sourcePath: %s\n", test.sourcePath)
			seedDirectoryRegistry(t, backend, manifest)
			seededObjects := map[string][]byte{
				"_artifacts/neighbor/probe.bin":  []byte("neighbor remains untouched"),
				"_artifacts/sre/previous.html":   []byte("earlier site projection"),
				"_indexes/sre/index.json":        []byte(`{"site":"sre","previous":true}`),
				"_control/registry-cleanup.json": []byte(`{"private":"admin control"}`),
			}
			for key, value := range seededObjects {
				if err := backend.PutObject(t.Context(), key, Object{Bytes: value}); err != nil {
					t.Fatalf("seed existing object %s: %v", key, err)
				}
			}

			_, err = PublishSite(t.Context(), backend, SitePublishOptions{
				SiteID: "sre", SourceDir: test.sourceDir, DryRun: test.dryRun,
			})
			if err == nil || !strings.Contains(err.Error(), "overlaps site source") {
				t.Fatalf("PublishSite() error = %v, want a clear source/target overlap error", err)
			}
			if _, _, err := backend.GetObject(t.Context(), siteLockKey("sre")); err == nil {
				t.Fatal("overlapping source/target created a site lock")
			} else if err != ErrObjectNotFound {
				t.Fatalf("read site lock: %v", err)
			}
			if keys, err := backend.ListKeys(t.Context(), "_artifacts/sre/"); err != nil || len(keys) != 1 || keys[0] != "_artifacts/sre/previous.html" {
				t.Fatalf("site artifacts after rejected publish = %v, err=%v; want only the preserved prior object", keys, err)
			}
			for key, expected := range seededObjects {
				object, _, err := backend.GetObject(t.Context(), key)
				if err != nil || string(object.Bytes) != string(expected) {
					t.Errorf("existing object %q after rejected publish = %q, err=%v", key, object.Bytes, err)
				}
			}
		})
	}
}

func TestPublishSiteIncludesIgnoredRegularFilesWhenLocalTargetIsSeparate(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := os.WriteFile(filepath.Join(root, ".gitignore"), []byte("/docs/artifacts/generated/\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	generatedHTML := []byte("<title>Generated report</title><h1>Generated report</h1>")
	generatedData := []byte("generated payload")
	generatedDir := filepath.Join(root, "docs", "artifacts", "generated")
	if err := os.MkdirAll(generatedDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(generatedDir, "summary.html"), generatedHTML, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(generatedDir, "payload.bin"), generatedData, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGitAt(root, "check-ignore", "--quiet", "docs/artifacts/generated/summary.html"); err != nil {
		t.Fatalf("generated HTML fixture is not ignored by Git: %v", err)
	}
	backend, err := NewDirectoryBackend(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	seedDirectoryRegistry(t, backend, registeredSREManifest)
	result, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("PublishSite() error = %v", err)
	}
	if result.Outcome != "published" {
		t.Fatalf("PublishSite() outcome = %q, want published", result.Outcome)
	}
	for key, expected := range map[string][]byte{
		"_artifacts/sre/generated/summary.html": generatedHTML,
		"_artifacts/sre/generated/payload.bin":  generatedData,
	} {
		object, _, err := backend.GetObject(t.Context(), key)
		if err != nil || string(object.Bytes) != string(expected) {
			t.Errorf("published ignored file %q = %q, err=%v", key, object.Bytes, err)
		}
	}
}

func TestRejectOverlappingLocalSourceResolvesSymlinkedTargetParent(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "docs", "artifacts")
	if err := os.MkdirAll(source, 0o755); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, ".local")
	if err := os.Symlink(source, alias); err != nil {
		t.Fatal(err)
	}
	err := rejectOverlappingLocalSource(filepath.Join(alias, "storage"), source)
	if err == nil || !strings.Contains(err.Error(), "overlaps site source") {
		t.Fatalf("rejectOverlappingLocalSource() error = %v, want symlink-resolved overlap", err)
	}
}

func seedDirectoryRegistry(t *testing.T, backend *DirectoryBackend, manifest string) {
	t.Helper()
	data, _, err := testRegistryBuild(t, []byte(manifest))
	if err != nil {
		t.Fatalf("build registry fixture: %v", err)
	}
	if err := backend.PutObject(t.Context(), "_indexes/sites.json", Object{Bytes: data}); err != nil {
		t.Fatalf("seed registry fixture: %v", err)
	}
}

func TestPublishSiteDryRunChecksRegistrationWithoutMutatingStorage(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteUnregisterRaceBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)

	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", DryRun: true})
	if err != nil {
		t.Fatalf("PublishSite(dry-run) error = %v", err)
	}
	if result.Outcome != "planned" || result.FilesPublished != 5 {
		t.Fatalf("PublishSite(dry-run) = %+v, want a five-file plan (document, index, metadata, search manifest and root blob)", result)
	}
	for _, operation := range backend.operationSnapshot() {
		if strings.HasPrefix(operation, "lock-held:") {
			t.Fatalf("dry-run acquired a site lock: %v", backend.operationSnapshot())
		}
	}
	if got := backend.contentMutations.Load(); got != 0 {
		t.Fatalf("dry-run performed %d content-plane mutations", got)
	}
	if keys, err := backend.lockMemoryBackend.ListKeys(context.Background(), "_control/locks/sites/"); err != nil || len(keys) != 0 {
		t.Fatalf("dry-run lock objects = %v, err=%v; want no lock writes", keys, err)
	}
}

func TestPublishSiteUsesOriginRegistryAfterSiteLockAndIgnoresBranch(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := runPublisherGit("checkout", "-qb", "feature/publish"); err != nil {
		t.Fatal(err)
	}
	backend := newSiteUnregisterRaceBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)

	result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil {
		t.Fatalf("PublishSite() error = %v", err)
	}
	if result.Outcome != "published" || result.Site != "sre" || result.FilesPublished != 5 {
		t.Fatalf("PublishSite() = %+v, want a successful publish independent of branch", result)
	}
	operations := backend.operationSnapshot()
	registryReadIndex, lockAcquireIndex := -1, -1
	for index, operation := range operations {
		if operation == "get:_indexes/sites.json" && registryReadIndex < 0 {
			registryReadIndex = index
		}
		if operation == "lock-held:"+siteLockKey("sre") && lockAcquireIndex < 0 {
			lockAcquireIndex = index
		}
	}
	if lockAcquireIndex < 0 || registryReadIndex < lockAcquireIndex {
		t.Fatalf("operations = %v, want site lock acquisition before provider-origin registry read", operations)
	}
	for _, key := range []string{"_artifacts/sre/report.html", "_indexes/sre/index.json", "_indexes/sre/meta.json"} {
		if _, exists := backend.lockMemoryBackend.objects[key]; !exists {
			t.Errorf("published object %q is missing", key)
		}
	}
	var discovery struct {
		Site struct {
			Description string `json:"description"`
		} `json:"site"`
	}
	if err := json.Unmarshal(backend.lockMemoryBackend.objects["_indexes/sre/meta.json"].Bytes, &discovery); err != nil || discovery.Site.Description != "Operational reviews and incident reports" {
		t.Errorf("published discovery metadata description = %q, err=%v; want the deployed registry description", discovery.Site.Description, err)
	}
}

func TestPublishFirstThenUnregisterWithdrawsAndCleansSite(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteUnregisterRaceBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREAndDocsManifest)
	seedSiteUnregisterProjectionFixtures(t, backend.lockMemoryBackend)
	backend.pauseFirstRegistryRead.Store(true)

	var releaseOnce sync.Once
	releasePublisherRead := func() { releaseOnce.Do(func() { close(backend.releaseRegistryRead) }) }
	type publishOutcome struct {
		result Result
		err    error
	}
	type unregisterOutcome struct {
		result Result
		err    error
	}
	publishDone := make(chan publishOutcome, 1)
	publishStopped := make(chan struct{})
	publishPending := true
	unregisterDone := make(chan unregisterOutcome, 1)
	unregisterStopped := make(chan struct{})
	unregisterPending := false
	defer func() {
		releasePublisherRead()
		if publishPending {
			awaitOperationCleanup(t, "publish", publishStopped)
		}
		if unregisterPending {
			awaitOperationCleanup(t, "unregister", unregisterStopped)
		}
	}()
	go func() {
		defer close(publishStopped)
		result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
		publishDone <- publishOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.registryReadReached, "publisher's origin registry read")

	unregisterPending = true
	go func() {
		defer close(unregisterStopped)
		result, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, docsOnlyManifest), "sre", false)
		unregisterDone <- unregisterOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.registryWriteReached, "registry withdrawal while publisher holds its site lock")
	awaitSiteSignal(t, backend.siteLockWaitReached, "unregister waiting for the publisher's site lock")
	registryObject, _, err := backend.lockMemoryBackend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatalf("read withdrawn origin registry: %v", err)
	}
	projection, err := registry.DecodeProjection(registryObject.Bytes)
	if err != nil || len(projection.Sites) != 1 || projection.Sites[0].ID != "docs" {
		t.Fatalf("registry while publisher holds lock = %+v, err=%v; want only neighboring registration", projection, err)
	}
	select {
	case outcome := <-unregisterDone:
		unregisterPending = false
		awaitOperationCleanup(t, "unregister", unregisterStopped)
		t.Fatalf("unregister completed before the publisher released its lock: %+v", outcome)
	default:
	}

	releasePublisherRead()
	select {
	case outcome := <-publishDone:
		publishPending = false
		awaitOperationCleanup(t, "publish", publishStopped)
		if outcome.err != nil || outcome.result.Outcome != "published" {
			t.Fatalf("publish-first result = %+v, err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("publish did not finish after its registry read was released")
	}
	select {
	case outcome := <-unregisterDone:
		unregisterPending = false
		awaitOperationCleanup(t, "unregister", unregisterStopped)
		if outcome.err != nil || outcome.result.Outcome != "unregistered" {
			t.Fatalf("unregister result = %+v, err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unregister did not finish after publisher released the site lock")
	}
	assertSiteIsUnregisteredAndEmpty(t, backend.lockMemoryBackend)
}

func TestUnregisterFirstBlocksPublishBeforeContentWrites(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteUnregisterRaceBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREAndDocsManifest)
	seedSiteUnregisterProjectionFixtures(t, backend.lockMemoryBackend)
	backend.pauseCleanupListing.Store(true)

	var releaseOnce sync.Once
	releaseCleanupListing := func() { releaseOnce.Do(func() { close(backend.releaseCleanupListing) }) }
	type unregisterOutcome struct {
		result Result
		err    error
	}
	type publishOutcome struct {
		result Result
		err    error
	}
	unregisterDone := make(chan unregisterOutcome, 1)
	unregisterStopped := make(chan struct{})
	unregisterPending := true
	publishDone := make(chan publishOutcome, 1)
	publishStopped := make(chan struct{})
	publishPending := false
	defer func() {
		releaseCleanupListing()
		if unregisterPending {
			awaitOperationCleanup(t, "unregister", unregisterStopped)
		}
		if publishPending {
			awaitOperationCleanup(t, "publish", publishStopped)
		}
	}()
	go func() {
		defer close(unregisterStopped)
		result, err := UnregisterSite(context.Background(), backend, testRegistryProjection(t, docsOnlyManifest), "sre", false)
		unregisterDone <- unregisterOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.registryWriteReached, "registry withdrawal")
	awaitSiteSignal(t, backend.cleanupListingReached, "unregister holding the site lock before cleanup")
	registryObject, _, err := backend.lockMemoryBackend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatalf("read withdrawn origin registry: %v", err)
	}
	projection, err := registry.DecodeProjection(registryObject.Bytes)
	if err != nil || len(projection.Sites) != 1 || projection.Sites[0].ID != "docs" {
		t.Fatalf("registry before competing publish = %+v, err=%v; want only neighboring registration", projection, err)
	}

	publishPending = true
	go func() {
		defer close(publishStopped)
		result, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
		publishDone <- publishOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.siteLockWaitReached, "publisher waiting behind unregister's site lock")
	mutationsWhileUnregisterPaused := backend.contentMutations.Load()
	select {
	case outcome := <-publishDone:
		publishPending = false
		awaitOperationCleanup(t, "publish", publishStopped)
		t.Fatalf("publish completed while unregister held the site lock: %+v", outcome)
	case <-time.After(150 * time.Millisecond):
	}
	if got := backend.contentMutations.Load(); got != mutationsWhileUnregisterPaused {
		t.Fatalf("content-plane mutations changed from %d to %d while unregister held the site lock", mutationsWhileUnregisterPaused, got)
	}

	releaseCleanupListing()
	select {
	case outcome := <-unregisterDone:
		unregisterPending = false
		awaitOperationCleanup(t, "unregister", unregisterStopped)
		if outcome.err != nil || outcome.result.Outcome != "unregistered" {
			t.Fatalf("unregister result = %+v, err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unregister did not finish after cleanup listing resumed")
	}
	mutationsAfterCleanup := backend.contentMutations.Load()
	select {
	case outcome := <-publishDone:
		publishPending = false
		awaitOperationCleanup(t, "publish", publishStopped)
		if outcome.err == nil || !strings.Contains(outcome.err.Error(), "is not registered") {
			t.Fatalf("publisher after unregister = %+v, err=%v; want a registry rejection", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("publisher did not finish after unregister released the site lock")
	}
	if got := backend.contentMutations.Load(); got != mutationsAfterCleanup {
		t.Fatalf("rejected publisher changed content-plane mutations from %d to %d", mutationsAfterCleanup, got)
	}
	assertSiteIsUnregisteredAndEmpty(t, backend.lockMemoryBackend)
}

type siteUnregisterRaceBackend struct {
	*lockMemoryBackend
	pauseFirstRegistryRead atomic.Bool
	registryReadOnce       atomic.Bool
	registryReadReached    chan struct{}
	releaseRegistryRead    chan struct{}
	registryWriteOnce      sync.Once
	registryWriteReached   chan struct{}
	siteLockWaitOnce       sync.Once
	siteLockWaitReached    chan struct{}
	pauseCleanupListing    atomic.Bool
	cleanupListingOnce     sync.Once
	cleanupListingReached  chan struct{}
	releaseCleanupListing  chan struct{}
	contentMutations       atomic.Int32
	operationsMu           sync.Mutex
	operations             []string
}

func newSiteUnregisterRaceBackend() *siteUnregisterRaceBackend {
	return &siteUnregisterRaceBackend{
		lockMemoryBackend:     newLockMemoryBackend(),
		registryReadReached:   make(chan struct{}),
		releaseRegistryRead:   make(chan struct{}),
		registryWriteReached:  make(chan struct{}),
		siteLockWaitReached:   make(chan struct{}),
		cleanupListingReached: make(chan struct{}),
		releaseCleanupListing: make(chan struct{}),
	}
}

func (backend *siteUnregisterRaceBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	backend.recordOperation("get:" + key)
	object, etag, err := backend.lockMemoryBackend.GetObject(ctx, key)
	if key == "_indexes/sites.json" && backend.pauseFirstRegistryRead.Load() && backend.registryReadOnce.CompareAndSwap(false, true) {
		close(backend.registryReadReached)
		<-backend.releaseRegistryRead
	}
	if key == siteLockKey("sre") && err == nil {
		var lock lockRecord
		if json.Unmarshal(object.Bytes, &lock) == nil && lock.State == "held" {
			backend.siteLockWaitOnce.Do(func() { close(backend.siteLockWaitReached) })
		}
	}
	return object, etag, err
}

func (backend *siteUnregisterRaceBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	if err == nil && key == siteLockKey("sre") {
		var lock lockRecord
		if json.Unmarshal(object.Bytes, &lock) == nil && lock.State == "held" {
			backend.recordOperation("lock-held:" + key)
		}
	}
	if key == "_indexes/sites.json" && err == nil {
		backend.registryWriteOnce.Do(func() { close(backend.registryWriteReached) })
	}
	return etag, err
}

func (backend *siteUnregisterRaceBackend) PutObject(ctx context.Context, key string, object Object) error {
	if strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/") {
		backend.contentMutations.Add(1)
	}
	return backend.lockMemoryBackend.PutObject(ctx, key, object)
}

func (backend *siteUnregisterRaceBackend) DeleteObjects(ctx context.Context, keys []string) error {
	for _, key := range keys {
		if strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/") {
			backend.contentMutations.Add(1)
			break
		}
	}
	return backend.lockMemoryBackend.DeleteObjects(ctx, keys)
}

func (backend *siteUnregisterRaceBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	for _, path := range paths {
		if strings.HasPrefix(path, "/_artifacts/sre/") || strings.HasPrefix(path, "/_indexes/sre/") {
			backend.contentMutations.Add(1)
			break
		}
	}
	return backend.lockMemoryBackend.Invalidate(ctx, paths)
}

func (backend *siteUnregisterRaceBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	if prefix == "_artifacts/sre/" && backend.pauseCleanupListing.Load() {
		backend.cleanupListingOnce.Do(func() {
			close(backend.cleanupListingReached)
			<-backend.releaseCleanupListing
		})
	}
	return backend.lockMemoryBackend.ListKeys(ctx, prefix)
}

func createPublisherCheckout(t *testing.T, origin string) string {
	t.Helper()
	root := t.TempDir()
	for _, args := range [][]string{
		{"init", "--quiet"},
		{"config", "user.name", "Artifact Pages Test"},
		{"config", "user.email", "test@example.invalid"},
		{"remote", "add", "origin", origin},
	} {
		if err := runPublisherGitAt(root, args...); err != nil {
			t.Fatal(err)
		}
	}
	for relative, contents := range map[string]string{
		"docs/artifacts/report.html": "<title>Report</title><h1>Report</h1>",
		"docs/other/alternate.html":  "<title>Alternate</title><h1>Alternate</h1>",
	} {
		absolute := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte(contents), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := runPublisherGitAt(root, "add", "docs"); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGitAt(root, "commit", "--quiet", "-m", "add publisher fixtures"); err != nil {
		t.Fatal(err)
	}
	previousDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previousDirectory) })
	return root
}

func runPublisherGit(args ...string) error {
	return runPublisherGitAt(".", args...)
}

func runPublisherGitAt(directory string, args ...string) error {
	command := exec.Command("git", args...)
	command.Dir = directory
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("git %v: %w: %s", args, err, output)
	}
	return nil
}

func seedPublisherRegistry(t *testing.T, backend *lockMemoryBackend, manifest string) {
	t.Helper()
	contents, _, err := testRegistryBuild(t, []byte(manifest))
	if err != nil {
		t.Fatalf("build test registry: %v", err)
	}
	seedMemoryObject(backend, "_indexes/sites.json", contents)
}

func seedMemoryObject(backend *lockMemoryBackend, key string, contents []byte) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.objects[key] = Object{Bytes: append([]byte(nil), contents...)}
	backend.etags[key] = `"seed-` + key + `"`
}

func assertNoPublishedSiteContent(t *testing.T, backend *lockMemoryBackend, siteID string) {
	t.Helper()
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for key := range backend.objects {
		if strings.HasPrefix(key, "_artifacts/"+siteID+"/") || strings.HasPrefix(key, "_indexes/"+siteID+"/") {
			t.Errorf("ineligible publish wrote content-plane object %q", key)
		}
	}
}

func assertSiteIsUnregisteredAndEmpty(t *testing.T, backend *lockMemoryBackend) {
	t.Helper()
	object, _, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatalf("read final registry: %v", err)
	}
	projection, err := registry.DecodeProjection(object.Bytes)
	if err != nil || len(projection.Sites) != 1 || projection.Sites[0].ID != "docs" {
		t.Fatalf("final registry = %+v, err=%v; want only neighboring docs site registered", projection, err)
	}
	for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", "_previews/sre/"} {
		keys, err := backend.ListKeys(context.Background(), prefix)
		if err != nil || len(keys) != 0 {
			t.Fatalf("final keys under %q = %v, err=%v; want empty", prefix, keys, err)
		}
	}
	for key, want := range map[string]string{
		"_artifacts/docs/neighbor.html": "neighbor artifact",
		"_indexes/docs/meta.json":       `{"site":"docs"}`,
		"_previews/docs/catalog.json":   `{"site":"docs"}`,
		"index.html":                    "application shell",
		"assets/app.js":                 "application asset",
		"_control/private/sentinel":     "private control object",
	} {
		object, _, err := backend.GetObject(context.Background(), key)
		if err != nil || string(object.Bytes) != want {
			t.Errorf("unrelated object %q = %q, err=%v; want %q", key, object.Bytes, err, want)
		}
	}
	for _, key := range []string{siteLockKey("sre"), siteLockKey("docs"), "_control/locks/registry.json"} {
		object, _, err := backend.GetObject(context.Background(), key)
		if err != nil {
			t.Errorf("control lock %q was removed: %v", key, err)
			continue
		}
		var record lockRecord
		if err := json.Unmarshal(object.Bytes, &record); err != nil || record.State != "free" {
			t.Errorf("control lock %q = %+v, err=%v; want retained free lock", key, record, err)
		}
	}
}

func seedSiteUnregisterProjectionFixtures(t *testing.T, backend *lockMemoryBackend) {
	t.Helper()
	for key, contents := range map[string][]byte{
		"_artifacts/sre/old.html":       []byte("old SRE artifact"),
		"_indexes/sre/meta.json":        []byte(`{"site":"sre"}`),
		"_artifacts/docs/neighbor.html": []byte("neighbor artifact"),
		"_indexes/docs/meta.json":       []byte(`{"site":"docs"}`),
		"_previews/docs/catalog.json":   []byte(`{"site":"docs"}`),
		"index.html":                    []byte("application shell"),
		"assets/app.js":                 []byte("application asset"),
		"_control/private/sentinel":     []byte("private control object"),
	} {
		seedMemoryObject(backend, key, contents)
	}
	live := previewPublishGroup("42", "abcdefabcdefabcdefabcdefabcdefabcdefabcd")
	seedPreviewPublishCatalog(t, backend, []preview.Group{live}, live.HeadSHA)
	for _, siteID := range []string{"sre", "docs"} {
		contents, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: siteID, State: "free"})
		if err != nil {
			t.Fatal(err)
		}
		seedMemoryObject(backend, siteLockKey(siteID), contents)
	}
}

func awaitSiteSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", name)
	}
}

func awaitOperationCleanup(t *testing.T, name string, stopped <-chan struct{}) {
	t.Helper()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Errorf("%s operation did not stop during test cleanup", name)
	}
}

func (backend *siteUnregisterRaceBackend) recordOperation(operation string) {
	backend.operationsMu.Lock()
	backend.operations = append(backend.operations, operation)
	backend.operationsMu.Unlock()
}

func (backend *siteUnregisterRaceBackend) operationSnapshot() []string {
	backend.operationsMu.Lock()
	defer backend.operationsMu.Unlock()
	return append([]string(nil), backend.operations...)
}
