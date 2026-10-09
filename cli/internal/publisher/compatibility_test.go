package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

func allReads() map[string][]int {
	reads := map[string][]int{}
	for name, schema := range compat.Current().Writes {
		reads[name] = []int{schema}
	}
	return reads
}
func pinnedContext() context.Context {
	return WithCompatibility(context.Background(), config.DeploymentConfig{CLI: &config.ComponentVersion{Version: "0.1.0"}, Web: &config.ComponentVersion{Version: "0.1.0"}}, false)
}
func testVersionBackend(t *testing.T) ConditionalObjectBackend {
	t.Helper()
	backend, err := NewDirectoryBackend(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return backend
}
func seedRecord(t *testing.T, backend DeploymentBackend, key string, record versionRecord) {
	t.Helper()
	if err := writeVersionRecord(context.Background(), backend, key, record); err != nil {
		t.Fatal(err)
	}
}
func bundleWithReads(t *testing.T, reads map[string][]int) string {
	t.Helper()
	archive := createWebBundle(t, map[string][]byte{"index.html": []byte("<script src=/assets/app.js></script>"), "assets/app.js": []byte("console.log('compat')")})
	contents, err := os.ReadFile(archive + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest releaseManifest
	if err := json.Unmarshal(contents, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Reads = reads
	contents, _ = json.Marshal(manifest)
	if err := os.WriteFile(archive+".json", contents, 0600); err != nil {
		t.Fatal(err)
	}
	return archive
}

type compatibilityTransport func(*http.Request) (*http.Response, error)

func (transport compatibilityTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}
func fakeManifest(t *testing.T, reads map[string][]int) {
	t.Helper()
	previous := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previous })
	http.DefaultTransport = compatibilityTransport(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != "github.com" || !strings.Contains(request.URL.EscapedPath(), "/releases/download/web%2Fv0.1.0/") {
			t.Fatalf("unexpected manifest URL %s", request.URL)
		}
		contents, _ := json.Marshal(releaseManifest{SchemaVersion: 1, Product: "artifact-pages", Component: "web", Version: "0.1.0", Archive: "artifact-pages-web-v0.1.0.tar.gz", Reads: reads})
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(contents))), Header: make(http.Header)}, nil
	})
}

func TestWriterCompatibilityUsesStoredWebAndFallback(t *testing.T) {
	backend := testVersionBackend(t)
	if err := checkWriter(context.Background(), backend, compat.Current().Writes); err != nil {
		t.Fatal(err)
	}
	cliOnly := WithCompatibility(context.Background(), config.DeploymentConfig{CLI: &config.ComponentVersion{Version: "0.1.0"}}, false)
	if err := checkWriter(cliOnly, backend, compat.Current().Writes); err == nil {
		t.Fatal("pinned CLI silently skipped unknown web")
	}
	fakeManifest(t, allReads())
	if err := checkWriter(pinnedContext(), backend, compat.Current().Writes); err != nil {
		t.Fatalf("fallback: %v", err)
	}
	reads := allReads()
	reads["artifact-index"] = []int{2}
	seedRecord(t, backend, appVersionsKey, versionRecord{SchemaVersion: 1, WebVersion: "0.0.9", Reads: reads})
	if err := checkWriter(pinnedContext(), backend, compat.Current().Writes); err == nil {
		t.Fatal("config fallback overrode actually deployed incompatible web")
	}
	seedRecord(t, backend, appVersionsKey, versionRecord{SchemaVersion: 2, WebVersion: "0.1.0", Reads: allReads()})
	accept := context.WithValue(pinnedContext(), compatibilityContextKey{}, CompatibilityOptions{Pinned: true, AcceptBreaking: true})
	if err := checkWriter(accept, backend, compat.Current().Writes); err == nil {
		t.Fatal("accept-breaking bypassed unknown record schema")
	}
}

func TestStoredCompatibilityUnknownUnreadableAndPreservedPlanes(t *testing.T) {
	backend := testVersionBackend(t)
	ctx := context.Background()
	desired := registry.Projection{SchemaVersion: 1, Sites: []registry.Entry{{ID: "sre", Name: "SRE", Repository: "Acme/sre", SourcePath: "docs"}}}
	if _, err := RegisterSites(ctx, backend, desired, false); err != nil {
		t.Fatal(err)
	}
	if err := checkStoredFormats(ctx, backend, allReads(), false); err == nil || !strings.Contains(err.Error(), "sre: unknown") {
		t.Fatalf("unknown sites: %v", err)
	}
	if err := checkStoredFormats(ctx, backend, allReads(), true); err != nil {
		t.Fatal(err)
	}
	seedRecord(t, backend, siteVersionsKey("sre"), versionRecord{SchemaVersion: 1, CLIVersion: "0.1.0", Writes: writerFormats("site-metadata", "artifact-index", "full-text-manifest")})
	merged, err := prepareWriterRecord(ctx, backend, siteVersionsKey("sre"), writerFormats("preview-catalog", "preview-manifest"))
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Writes) != 5 {
		t.Fatalf("preview overwrote production formats: %v", merged.Writes)
	}
	seedRecord(t, backend, siteVersionsKey("sre"), merged)
	if err := checkStoredFormats(ctx, backend, allReads(), false); err != nil {
		t.Fatal(err)
	}
	bad := allReads()
	bad["artifact-index"] = []int{2}
	if err := checkStoredFormats(ctx, backend, bad, false); err == nil || !strings.Contains(err.Error(), "sre") {
		t.Fatalf("unreadable site: %v", err)
	}
	merged.Writes = writerFormats("preview-catalog", "preview-manifest")
	seedRecord(t, backend, siteVersionsKey("sre"), merged)
	if err := backend.PutObject(ctx, "_indexes/sre/meta.json", Object{Bytes: []byte(`{"schemaVersion":1}`)}); err != nil {
		t.Fatal(err)
	}
	if err := checkStoredFormats(ctx, backend, allReads(), false); err == nil || !strings.Contains(err.Error(), "unknown") {
		t.Fatalf("preview-only falsely certified production: %v", err)
	}
	merged.SchemaVersion = 2
	seedRecord(t, backend, siteVersionsKey("sre"), merged)
	if err := checkStoredFormats(ctx, backend, allReads(), true); err == nil {
		t.Fatal("unknown site schema bypassed")
	}
}

func TestMixedWebVersionsBreakingUpgradeAndNoWritesOnRefusal(t *testing.T) {
	backend := testVersionBackend(t)
	ctx := context.Background()
	empty := registry.Projection{SchemaVersion: 1, Sites: []registry.Entry{}}
	if _, err := RegisterSites(ctx, backend, empty, false); err != nil {
		t.Fatal(err)
	}
	olderReads := allReads()
	olderReads["artifact-index"] = []int{2}
	olderArchive := bundleWithReads(t, olderReads)
	if _, err := DeployApp(ctx, backend, AppDeployOptions{ArchivePath: olderArchive}); err != nil {
		t.Fatal(err)
	}
	before, _, err := backend.GetObject(ctx, registryVersionsKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RegisterSites(pinnedContext(), backend, empty, false); err == nil {
		t.Fatal("new writer accepted incompatible older web")
	}
	after, _, _ := backend.GetObject(ctx, registryVersionsKey)
	if string(before.Bytes) != string(after.Bytes) {
		t.Fatal("refused operation changed registry record")
	}
	accept := context.WithValue(pinnedContext(), compatibilityContextKey{}, CompatibilityOptions{Pinned: true, AcceptBreaking: true})
	if _, err := RegisterSites(accept, backend, empty, false); err != nil {
		t.Fatal(err)
	}
	currentArchive := bundleWithReads(t, allReads())
	if _, err := DeployApp(accept, backend, AppDeployOptions{ArchivePath: currentArchive}); err != nil {
		t.Fatal(err)
	}
	if err := checkWriter(pinnedContext(), backend, compat.Current().Writes); err != nil {
		t.Fatalf("upgrade did not converge: %v", err)
	}
	record, present, err := readVersionRecord(ctx, backend, appVersionsKey)
	if err != nil || !present || record.Pending {
		t.Fatalf("deployed record: %+v %v", record, err)
	}
	if _, err := RemoveApp(ctx, backend, AppRemoveOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := backend.GetObject(ctx, appVersionsKey); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("removed app left version record: %v", err)
	}
}

func TestConfigCheckAndPendingRecords(t *testing.T) {
	backend := testVersionBackend(t)
	fakeManifest(t, allReads())
	if err := CheckConfig(pinnedContext(), backend); err != nil {
		t.Fatal(err)
	}
	seedRecord(t, backend, appVersionsKey, versionRecord{SchemaVersion: 1, WebVersion: "0.1.0", Reads: allReads(), Pending: true})
	if err := checkWriter(pinnedContext(), backend, compat.Current().Writes); err == nil {
		t.Fatal("writer accepted pending app")
	}
	archive := bundleWithReads(t, allReads())
	if _, err := DeployApp(pinnedContext(), backend, AppDeployOptions{ArchivePath: archive}); err != nil {
		t.Fatalf("pending app retry: %v", err)
	}
	if err := checkWriter(pinnedContext(), backend, compat.Current().Writes); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyProjectionMigratesThroughPlannedOrder(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := runPublisherGitAt(root, "branch", "--move", "main"); err != nil {
		t.Fatal(err)
	}
	backend := testVersionBackend(t)
	ctx := WithCompatibility(context.Background(), config.DeploymentConfig{
		CLI: &config.ComponentVersion{Version: "0.2.0"}, Web: &config.ComponentVersion{Version: "0.1.0"},
	}, false)
	fakeManifest(t, allReads())

	legacyProjection, _, err := testRegistryBuild(t, []byte(registeredSREManifest))
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutObject(ctx, "_indexes/sites.json", Object{Bytes: legacyProjection}); err != nil {
		t.Fatal(err)
	}
	if _, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}); err != nil {
		t.Fatalf("seed pre-record site projection: %v", err)
	}
	if err := backend.DeleteObjects(context.Background(), []string{siteVersionsKey("sre")}); err != nil {
		t.Fatalf("remove version record to model legacy storage: %v", err)
	}
	if err := CheckConfig(ctx, backend); err == nil || !strings.Contains(err.Error(), "registry: unknown") || !strings.Contains(err.Error(), "sre: unknown; republish required") {
		t.Fatalf("initial config check = %v; want diagnostic for missing legacy records", err)
	}

	desired, err := registry.DecodeProjection(legacyProjection)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RegisterSites(ctx, backend, desired, false); err != nil {
		t.Fatalf("registry sync: %v", err)
	}
	if err := CheckConfig(ctx, backend); err == nil || strings.Contains(err.Error(), "registry: unknown") || !strings.Contains(err.Error(), "sre: unknown; republish required") {
		t.Fatalf("config check after registry sync = %v; want only the unrecorded site diagnostic", err)
	}

	archive := bundleWithReads(t, allReads())
	if _, err := DeployApp(ctx, backend, AppDeployOptions{ArchivePath: archive}); err == nil || !strings.Contains(err.Error(), "sre: unknown; republish required") {
		t.Fatalf("ordinary app deploy = %v; want refusal before unknown site formats are accepted", err)
	}
	approvedContext := WithCompatibility(context.Background(), config.DeploymentConfig{
		CLI: &config.ComponentVersion{Version: "0.2.0"}, Web: &config.ComponentVersion{Version: "0.1.0"},
	}, true)
	if _, err := DeployApp(approvedContext, backend, AppDeployOptions{ArchivePath: archive}); err != nil {
		t.Fatalf("approved app deploy with accept-breaking: %v", err)
	}
	if _, err := PublishSite(ctx, backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}); err != nil {
		t.Fatalf("site sync: %v", err)
	}
	if err := CheckConfig(ctx, backend); err != nil {
		t.Fatalf("final config check after records exist: %v", err)
	}
	for _, key := range []string{registryVersionsKey, siteVersionsKey("sre")} {
		record, present, err := readVersionRecord(ctx, backend, key)
		if err != nil || !present || record.CLIVersion != "0.2.0" {
			t.Fatalf("version record %s = %+v, present=%t, err=%v; want writing CLI 0.2.0", key, record, present, err)
		}
	}
}

func TestSiteRecordStagedOnFailureAndRetryConverges(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	backend.failPutKey = "_indexes/sre/meta.json"
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Reconcile: true}
	if _, err := PublishSite(context.Background(), backend, options); err == nil {
		t.Fatal("expected projection failure")
	}
	record, present, err := readVersionRecord(context.Background(), backend, siteVersionsKey("sre"))
	if err != nil || !present || !record.Pending {
		t.Fatalf("partial projection was certified: %+v %v", record, err)
	}
	if err := checkStoredFormats(context.Background(), backend, allReads(), false); err == nil {
		t.Fatal("pending site treated as compatible")
	}
	if _, err := PublishSite(context.Background(), backend, options); err != nil {
		t.Fatal(err)
	}
	record, _, err = readVersionRecord(context.Background(), backend, siteVersionsKey("sre"))
	if err != nil || record.Pending {
		t.Fatalf("retry retained pending site record: %+v %v", record, err)
	}
	for format, key := range map[string]string{"site-metadata": "_indexes/sre/meta.json", "artifact-index": "_indexes/sre/index.json", "full-text-manifest": "_indexes/sre/search/manifest.json"} {
		object, _, err := backend.GetObject(context.Background(), key)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			SchemaVersion int `json:"schemaVersion"`
			Version       int `json:"version"`
		}
		if err := json.Unmarshal(object.Bytes, &envelope); err != nil {
			t.Fatal(err)
		}
		actual := envelope.SchemaVersion
		if format == "full-text-manifest" {
			actual = envelope.Version
		}
		if record.Writes[format] != actual || compat.Current().Writes[format] != actual {
			t.Fatalf("declared %s schema differs from actual writer: %+v, actual=%d", format, record.Writes, actual)
		}
	}
}

func TestAppDeployRefusesStoredUnknownBeforeLockAndWrites(t *testing.T) {
	backend := testVersionBackend(t)
	ctx := context.Background()
	seedRecord(t, backend, registryVersionsKey, versionRecord{SchemaVersion: 2, CLIVersion: "0.1.0", Writes: writerFormats("registry")})
	archive := bundleWithReads(t, allReads())
	accept := context.WithValue(pinnedContext(), compatibilityContextKey{}, CompatibilityOptions{Pinned: true, AcceptBreaking: true})
	if _, err := DeployApp(accept, backend, AppDeployOptions{ArchivePath: archive}); err == nil {
		t.Fatal("accepted unknown registry schema")
	}
	for _, key := range []string{applicationLockKey, appVersionsKey, "index.html", appCacheRetryObjectKey} {
		if _, _, err := backend.GetObject(ctx, key); !errors.Is(err, ErrObjectNotFound) {
			t.Fatalf("refused app deploy wrote %s", key)
		}
	}
}

type changingSiteVersionBackend struct {
	*lockMemoryBackend
	changed bool
}

func (backend *changingSiteVersionBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	if key == siteLockKey("sre") && !backend.changed {
		backend.changed = true
		contents, _ := json.Marshal(versionRecord{SchemaVersion: 2, CLIVersion: "future", Writes: writerFormats("artifact-index")})
		if err := backend.lockMemoryBackend.PutObject(ctx, siteVersionsKey("sre"), Object{Bytes: contents}); err != nil {
			return Object{}, "", err
		}
	}
	return backend.lockMemoryBackend.GetObject(ctx, key)
}
func TestRegistryRechecksVersionUnderRemovedSiteLockBeforeCatalogMutation(t *testing.T) {
	backend := &changingSiteVersionBackend{lockMemoryBackend: newLockMemoryBackend()}
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	seedRecord(t, backend, siteVersionsKey("sre"), versionRecord{SchemaVersion: 1, CLIVersion: "0.1.0", Writes: writerFormats("artifact-index")})
	before, _, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatal(err)
	}
	empty := registry.Projection{SchemaVersion: 1, Sites: []registry.Entry{}}
	if _, err := RegisterSites(context.Background(), backend, empty, false); err == nil {
		t.Fatal("registry ignored version changed before site lock acquisition")
	}
	after, _, err := backend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil || string(before.Bytes) != string(after.Bytes) {
		t.Fatal("unknown schema changed catalog before refusal")
	}
	if _, _, err := backend.GetObject(context.Background(), registryCleanupKey); !errors.Is(err, ErrObjectNotFound) {
		t.Fatal("unknown schema wrote cleanup journal")
	}
}

func TestPublishedRecordConstantsMatchEmbeddedWrites(t *testing.T) {
	writes := compat.Current().Writes
	if writes["registry"] != registry.SchemaVersion || writes["preview-catalog"] != preview.SchemaVersion || writes["preview-manifest"] != preview.SchemaVersion {
		t.Fatalf("writer constants drifted from compatibility asset: %v", writes)
	}
}

type webTransitionRaceBackend struct {
	*siteReconcileBackend
	appReads    int
	startDeploy func()
}

func (backend *webTransitionRaceBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	object, etag, err := backend.siteReconcileBackend.GetObject(ctx, key)
	if key == appVersionsKey {
		backend.appReads++
		if backend.appReads == 2 {
			backend.startDeploy()
		}
	}
	return object, etag, err
}
func TestAppTransitionWaitsForLockedWriterThenChecksCompletedFormats(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")
	inner := newSiteReconcileBackend()
	seedPublisherRegistry(t, inner.lockMemoryBackend, registeredSREManifest)
	seedRecord(t, inner, registryVersionsKey, versionRecord{SchemaVersion: 1, CLIVersion: "0.1.0", Writes: writerFormats("registry")})
	seedRecord(t, inner, siteVersionsKey("sre"), versionRecord{SchemaVersion: 1, CLIVersion: "0.1.0", Writes: writerFormats("preview-catalog", "preview-manifest")})
	seedRecord(t, inner, appVersionsKey, versionRecord{SchemaVersion: 1, WebVersion: "0.1.0", Reads: allReads()})
	nextReads := allReads()
	nextReads["full-text-manifest"] = []int{2}
	archive := bundleWithReads(t, nextReads)
	inner.heldRead = make(chan struct{}, 4)
	deployed := make(chan error, 1)
	wrapper := &webTransitionRaceBackend{siteReconcileBackend: inner}
	wrapper.startDeploy = func() {
		go func() {
			_, err := DeployApp(context.Background(), inner, AppDeployOptions{ArchivePath: archive})
			deployed <- err
		}()
		select {
		case <-inner.heldRead:
		case <-time.After(3 * time.Second):
			t.Fatal("app transition did not wait for writer's held site lock")
		}
		select {
		case err := <-deployed:
			t.Fatalf("app transition overtook writer: %v", err)
		default:
		}
	}
	if _, err := PublishSite(context.Background(), wrapper, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", Reconcile: true}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-deployed:
		if err == nil || !strings.Contains(err.Error(), "full-text-manifest") {
			t.Fatalf("transition ignored writer's completed new formats: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("app transition did not complete after writer released lock")
	}
	app, _, err := readVersionRecord(context.Background(), inner, appVersionsKey)
	if err != nil {
		t.Fatal(err)
	}
	site, _, err := readVersionRecord(context.Background(), inner, siteVersionsKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	if err := compat.CheckReads(app.Reads, site.Writes); err != nil {
		t.Fatalf("successful writer left incompatible actual web: %v", err)
	}
}

func TestPreviewCannotCertifyIncompleteProductionWrite(t *testing.T) {
	backend := testVersionBackend(t)
	writes := writerFormats("artifact-index", "site-metadata", "full-text-manifest", "preview-catalog", "preview-manifest")
	seedRecord(t, backend, siteVersionsKey("sre"), versionRecord{SchemaVersion: 1, CLIVersion: "0.1.0", Writes: writes, Pending: true, PendingWrites: writerFormats("artifact-index", "site-metadata", "full-text-manifest")})
	if _, err := prepareWriterRecord(context.Background(), backend, siteVersionsKey("sre"), writerFormats("preview-catalog", "preview-manifest")); err == nil {
		t.Fatal("preview falsely repaired incomplete production writes")
	}
	record, err := prepareWriterRecord(context.Background(), backend, siteVersionsKey("sre"), writerFormats("artifact-index", "site-metadata", "full-text-manifest"))
	if err != nil || record.Pending || record.PendingWrites != nil {
		t.Fatalf("original writer cannot retry: %+v %v", record, err)
	}
}

func TestAppDownloadSelectsIndependentWebTag(t *testing.T) {
	archive := bundleWithReads(t, allReads())
	manifestContents, err := os.ReadFile(archive + ".json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest releaseManifest
	if err := json.Unmarshal(manifestContents, &manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Version = "0.1.0"
	manifest.Archive = "artifact-pages-web-v0.1.0.tar.gz"
	manifestContents, _ = json.Marshal(manifest)
	archiveContents, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	assets := map[string][]byte{"": archiveContents, ".json": manifestContents, ".sha256": []byte(manifest.ArchiveSHA256 + "  " + manifest.Archive + "\n")}
	previous := http.DefaultTransport
	t.Cleanup(func() { http.DefaultTransport = previous })
	var requests int
	http.DefaultTransport = compatibilityTransport(func(request *http.Request) (*http.Response, error) {
		prefix := "/artifact-pages/artifact-pages/releases/download/web%2Fv0.1.0/" + manifest.Archive
		if request.URL.Host != "github.com" || !strings.HasPrefix(request.URL.EscapedPath(), prefix) {
			t.Fatalf("wrong web release URL: %s", request.URL)
		}
		suffix := strings.TrimPrefix(request.URL.EscapedPath(), prefix)
		contents, present := assets[suffix]
		if !present {
			t.Fatalf("wrong asset suffix %q", suffix)
		}
		requests++
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(contents))), Header: make(http.Header)}, nil
	})
	if _, err := DeployApp(pinnedContext(), testVersionBackend(t), AppDeployOptions{Version: "0.1.0", IndependentWeb: true}); err != nil {
		t.Fatal(err)
	}
	if requests != 3 {
		t.Fatalf("downloaded %d assets", requests)
	}
	if _, _, err := resolveAppArchive(context.Background(), AppDeployOptions{Version: "0.1.0", IndependentWeb: true, Repository: "arbitrary/repo"}); err == nil {
		t.Fatal("config pin accepted a foreign release repository")
	}
}

func TestPreviewCannotCertifyRetainedUnsupportedManifest(t *testing.T) {
	for _, recorded := range []bool{false, true} {
		t.Run(fmt.Sprintf("recorded-%t", recorded), func(t *testing.T) {
			root := createPreviewPublisherCheckout(t)
			backend := newSiteReconcileBackend()
			seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
			const oldSHA = "4444444444444444444444444444444444444444"
			manifest, _ := previewRemoveTestManifest("sre", oldSHA, "guide.md")
			manifest.SchemaVersion = 2
			contents, _ := json.Marshal(manifest)
			key := "_previews/sre/revisions/" + oldSHA + "/manifest.json"
			if err := backend.PutObject(context.Background(), key, Object{Bytes: contents}); err != nil {
				t.Fatal(err)
			}
			if recorded {
				writes := writerFormats("preview-catalog", "preview-manifest")
				writes["preview-manifest"] = 2
				seedRecord(t, backend, siteVersionsKey("sre"), versionRecord{SchemaVersion: 1, CLIVersion: "0.1.0", Writes: writes})
			}
			before, _, beforeErr := backend.GetObject(context.Background(), siteVersionsKey("sre"))
			backend.resetEvents()
			if _, err := BuildAndPublishPreview(context.Background(), backend, previewBuildOptions(root)); err == nil || !strings.Contains(err.Error(), oldSHA) {
				t.Fatalf("retained unsupported revision was falsely certified: %v", err)
			}
			after, _, afterErr := backend.GetObject(context.Background(), siteVersionsKey("sre"))
			if !errors.Is(beforeErr, afterErr) || string(before.Bytes) != string(after.Bytes) {
				t.Fatal("refused preview changed version record")
			}
			for _, event := range backend.eventSnapshot() {
				if strings.HasPrefix(event, "put:") || strings.HasPrefix(event, "delete:") {
					t.Fatalf("retained-history refusal wrote data: %v", backend.eventSnapshot())
				}
			}
			if _, _, err := backend.GetObject(context.Background(), siteLockKey("sre")); !errors.Is(err, ErrObjectNotFound) {
				t.Fatal("retained-history refusal acquired a lock before preflight")
			}
		})
	}
}
