package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"math"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
)

const (
	sitePublishMatrixEnv       = "ARTIFACT_PAGES_SCALE_MATRIX"
	sitePublishMatrixOutputEnv = "ARTIFACT_PAGES_SCALE_MATRIX_OUTPUT"
	sitePublishMatrixFilesEnv  = "ARTIFACT_PAGES_SCALE_MATRIX_FIXTURE_ROOT"
	sitePublishMatrixSeed      = int64(0x5ca1e2026)
)

// TestSitePublishDifferenceMatrix is an opt-in, deterministic distribution
// matrix for the real PublishSite flow. It mutates only temporary fixture
// copies, starts every case from a cloned successful projection, and compares
// the result with a fresh indexer build. Set ARTIFACT_PAGES_SCALE_MATRIX=1 to
// run the full matrix; ARTIFACT_PAGES_SCALE_MATRIX_FIXTURE_ROOT may point at a
// copied "sites" fixture directory for replay on an older Git revision.
func TestSitePublishDifferenceMatrix(t *testing.T) {
	if os.Getenv(sitePublishMatrixEnv) != "1" {
		t.Skip("set ARTIFACT_PAGES_SCALE_MATRIX=1 to run the publisher difference matrix")
	}
	ctx := context.Background()
	root, err := matrixGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	revision, err := matrixGitRevision(ctx)
	if err != nil {
		t.Fatal(err)
	}
	fixtureRoot := os.Getenv(sitePublishMatrixFilesEnv)
	if fixtureRoot == "" {
		fixtureRoot = filepath.Join(root, "fixtures", "scale", "sites")
	} else if !filepath.IsAbs(fixtureRoot) {
		fixtureRoot = filepath.Join(root, fixtureRoot)
	}
	fixtureRoot, err = filepath.Abs(fixtureRoot)
	if err != nil {
		t.Fatal(err)
	}
	selectedSizes, err := matrixSelectedSizes(os.Getenv("ARTIFACT_PAGES_SCALE_MATRIX_SIZES"))
	if err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(root, "cli", ".local", "publish-difference-matrix-work")
	if err := os.RemoveAll(work); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(work), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)

	oracle, err := matrixBuildOracleForRevision(t, root, work)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	report := matrixReport{
		SchemaVersion: 1, PublisherRevision: revision, FixtureRoot: fixtureRoot,
		Seed: sitePublishMatrixSeed, OracleTimingMode: oracle.timingMode,
		StartedAt: start.UTC().Format(time.RFC3339),
	}

	for _, size := range selectedSizes {
		fixtureID := fmt.Sprintf("verify-scale-%d", size)
		fixtureSource := filepath.Join(fixtureRoot, fixtureID, "source")
		profile := matrixCountSource(t, fixtureSource)
		if profile.SourceFiles != size {
			t.Fatalf("fixture %s contains %d files; want %d", fixtureID, profile.SourceFiles, size)
		}
		copyDir := filepath.Join(work, fmt.Sprintf("scale-%d", size), "source")
		if err := copyScaleTree(fixtureSource, copyDir); err != nil {
			t.Fatalf("copy %s: %v", fixtureID, err)
		}
		sources, err := matrixReadSources(copyDir)
		if err != nil {
			t.Fatalf("snapshot %s: %v", fixtureID, err)
		}
		siteID := fmt.Sprintf("verify-matrix-%d", size)
		identity, err := indexer.ResolveGitSourceIdentity(ctx, copyDir)
		if err != nil {
			t.Fatalf("resolve %s source identity: %v", fixtureID, err)
		}
		site := registry.Site{
			Name: "Scale Matrix " + fmt.Sprint(size), Description: "Deterministic publisher verification site",
			Repository: identity.Repository, SourcePath: identity.SourcePath,
		}
		baseline := matrixPublishBaseline(t, ctx, siteID, copyDir, site)
		report.Datasets = append(report.Datasets, matrixDatasetReport{
			FixtureSite: fixtureID, Site: siteID, SourceFiles: profile.SourceFiles,
			Pages: profile.Pages, Resources: profile.Resources,
			FixtureSHA256: matrixSourcesDigest(sources),
		})

		scenarios := matrixCoreScenarios(size)
		scenarios = append(scenarios, matrixScenarioSpec{
			Name: "reconcile-no-op", Kind: "no-op", RateLabels: []string{"0%"},
			Distribution: "none", Reconcile: true,
		})
		if size == 1000 {
			scenarios = append(scenarios,
				matrixScenarioSpec{Name: "resource-only-10-percent", Kind: "resource-only", RateLabels: []string{"10%"}, Distribution: "uniform-scattered", Count: int(math.Round(float64(size) * 0.10))},
				matrixScenarioSpec{Name: "page-mixed-10-percent", Kind: "page-mixed", RateLabels: []string{"10%"}, Distribution: "uniform-scattered", Count: int(math.Round(float64(size) * 0.10))},
				matrixScenarioSpec{Name: "reconcile-missing-object", Kind: "origin-drift", RateLabels: []string{"0%"}, Distribution: "not-applicable", Reconcile: true, DeleteOriginObject: true},
			)
		}
		for _, spec := range scenarios {
			changedPaths, oldBytes, newBytes, changedTypes, err := matrixMutateSources(copyDir, sources, spec, size)
			if err != nil {
				t.Fatalf("prepare scenario %s/%s: %v", siteID, spec.Name, err)
			}
			backend := matrixCloneBackend(baseline)
			beforeProjection := matrixProjectionSnapshot(backend, siteID)
			stableObjects := matrixStableObjectsSnapshot(backend)
			driftKeys := []string(nil)
			if spec.DeleteOriginObject {
				resource := matrixFirstSource(sources, false)
				key := "_artifacts/" + siteID + "/" + resource.RelativePath
				if err := backend.lockMemoryBackend.DeleteObjects(ctx, []string{key}); err != nil {
					t.Fatalf("inject drift for %s: %v", spec.Name, err)
				}
				driftKeys = []string{key}
			}
			backend.resetMetrics()
			options := SitePublishOptions{SiteID: siteID, SourceDir: copyDir}
			reconcileAvailable := matrixSetReconcile(&options, spec.Reconcile)
			wallStart := time.Now()
			result, publishErr := PublishSite(ctx, backend, options)
			wall := time.Since(wallStart)
			if publishErr != nil {
				t.Fatalf("PublishSite(%s/%s): %v", siteID, spec.Name, publishErr)
			}
			generatedAt, err := matrixProjectionGeneratedAt(backend, siteID)
			if err != nil {
				t.Fatalf("read generatedAt after %s: %v", spec.Name, err)
			}
			afterProjection := matrixProjectionSnapshot(backend, siteID)
			oracleProjection, stageTimes, err := matrixBuildDesiredProjection(ctx, t, oracle, root, work, copyDir, siteID, site, identity, generatedAt, afterProjection)
			if err != nil {
				t.Fatalf("fresh desired projection for %s: %v", spec.Name, err)
			}
			if err := matrixAssertProjectionMatches(t, siteID, spec.Name, afterProjection, oracleProjection); err != nil {
				t.Fatal(err)
			}
			if err := matrixAssertNeighborAndControlPreserved(t, backend, stableObjects); err != nil {
				t.Fatalf("%s changed neighboring state: %v", spec.Name, err)
			}
			calls := backend.metricsSnapshot(siteID)
			buildSkipped, buildSkippedAvailable := matrixResultBuildSkipped(result)
			actualDeltas := matrixObjectDeltas(beforeProjection, afterProjection)
			report.Scenarios = append(report.Scenarios, matrixScenarioReport{
				Name: spec.Name, Site: siteID, SourceFiles: size, Kind: spec.Kind,
				RateLabels: spec.RateLabels, Distribution: spec.Distribution, Seed: sitePublishMatrixSeed,
				RequestedCount: spec.Count, ChangedSourcePaths: changedPaths,
				ChangedSourcePathCount: len(changedPaths), ChangedPages: changedTypes.Pages,
				ChangedResources: changedTypes.Resources, SourceBytesBefore: oldBytes,
				SourceBytesAfter: newBytes, SourceBytesChanged: newBytes - oldBytes,
				SourceBytesTouched: oldBytes + newBytes,
				TouchedDirectories: matrixTouchedDirectories(changedPaths),
				OriginDriftKeys:    driftKeys, GeneratedObjectDeltas: actualDeltas,
				Outcome: result.Outcome, BuildSkipped: buildSkipped,
				BuildSkippedAvailable: buildSkippedAvailable,
				ReconcileRequested:    spec.Reconcile, ReconcileOptionAvailable: reconcileAvailable,
				Calls: calls, PrepareMS: stageTimes.PrepareMS, BuildMS: stageTimes.BuildMS,
				PrepareBuildMS: stageTimes.PrepareBuildMS, StageTimingMode: stageTimes.Mode,
				WallMS: float64(wall.Microseconds()) / 1000,
			})
			if err := matrixRestoreSources(copyDir, sources, changedPaths); err != nil {
				t.Fatalf("restore source after %s: %v", spec.Name, err)
			}
		}
	}

	report.ElapsedMS = float64(time.Since(start).Microseconds()) / 1000
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	outputPath := os.Getenv(sitePublishMatrixOutputEnv)
	if outputPath == "" {
		outputDir := filepath.Join(root, ".local", "publish-scale-difference-matrix")
		if err := os.MkdirAll(outputDir, 0o700); err != nil {
			t.Fatal(err)
		}
		outputPath = filepath.Join(outputDir, "matrix-"+revision[:12]+".json")
	} else if !filepath.IsAbs(outputPath) {
		outputPath = filepath.Join(root, outputPath)
	}
	if err := os.MkdirAll(filepath.Dir(outputPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outputPath, append(encoded, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("SITE_PUBLISH_DIFFERENCE_MATRIX_JSON=%s", outputPath)
	t.Logf("SITE_PUBLISH_DIFFERENCE_MATRIX_SUMMARY revision=%s datasets=%d scenarios=%d elapsedMs=%.1f", revision, len(report.Datasets), len(report.Scenarios), report.ElapsedMS)
}

type matrixSourceProfile struct {
	SourceFiles int `json:"sourceFiles"`
	Pages       int `json:"pages"`
	Resources   int `json:"resources"`
}

type matrixSourceFile struct {
	RelativePath string
	Bytes        []byte
	Mode         fs.FileMode
	ModTime      time.Time
}

type matrixScenarioSpec struct {
	Name               string
	Kind               string
	RateLabels         []string
	Distribution       string
	Count              int
	Reconcile          bool
	DeleteOriginObject bool
}

type matrixDatasetReport struct {
	FixtureSite   string `json:"fixtureSite"`
	Site          string `json:"site"`
	SourceFiles   int    `json:"sourceFiles"`
	Pages         int    `json:"pages"`
	Resources     int    `json:"resources"`
	FixtureSHA256 string `json:"fixtureSha256"`
}

type matrixCallReport struct {
	Counts               map[string]int `json:"calls"`
	ListedKeys           int            `json:"listedKeys"`
	DeletedKeys          int            `json:"deletedKeys"`
	GetBodyBytes         int64          `json:"getBodyBytes"`
	ListJSONBytes        int64          `json:"listJsonBytes"`
	PutBodyBytes         int64          `json:"putBodyBytes"`
	StateHeadCalls       int            `json:"stateHeadCalls"`
	StateGetCalls        int            `json:"stateGetCalls"`
	StatePutCalls        int            `json:"statePutCalls"`
	StateDeleteCalls     int            `json:"stateDeleteCalls"`
	StateBodyReadBytes   int64          `json:"stateBodyReadBytes"`
	StateBodyWriteBytes  int64          `json:"stateBodyWriteBytes"`
	ProjectionListCalls  int            `json:"projectionListCalls"`
	ProjectionHeadCalls  int            `json:"projectionHeadCalls"`
	ProjectionGetCalls   int            `json:"projectionGetCalls"`
	ProjectionReadTimeMS float64        `json:"projectionReadTimeMs"`
	StateReadTimeMS      float64        `json:"stateReadTimeMs"`
}

type matrixObjectDelta struct {
	Action string `json:"action"`
	Key    string `json:"key"`
}

type matrixStageTimes struct {
	PrepareMS      float64 `json:"prepareMs,omitempty"`
	BuildMS        float64 `json:"buildMs,omitempty"`
	PrepareBuildMS float64 `json:"prepareBuildMs,omitempty"`
	Mode           string  `json:"mode"`
}

type matrixScenarioReport struct {
	Name                     string              `json:"name"`
	Site                     string              `json:"site"`
	SourceFiles              int                 `json:"sourceFiles"`
	Kind                     string              `json:"kind"`
	RateLabels               []string            `json:"rateLabels,omitempty"`
	Distribution             string              `json:"distribution"`
	Seed                     int64               `json:"seed"`
	RequestedCount           int                 `json:"requestedChangedCount"`
	ChangedSourcePaths       []string            `json:"changedSourcePaths"`
	ChangedSourcePathCount   int                 `json:"changedSourcePathCount"`
	ChangedPages             int                 `json:"changedPages"`
	ChangedResources         int                 `json:"changedResources"`
	SourceBytesBefore        int64               `json:"sourceBytesBefore"`
	SourceBytesAfter         int64               `json:"sourceBytesAfter"`
	SourceBytesChanged       int64               `json:"sourceBytesChanged"`
	SourceBytesTouched       int64               `json:"sourceBytesTouched"`
	TouchedDirectories       []string            `json:"touchedDirectories"`
	OriginDriftKeys          []string            `json:"originDriftKeys,omitempty"`
	GeneratedObjectDeltas    []matrixObjectDelta `json:"generatedObjectDeltas"`
	Outcome                  string              `json:"outcome"`
	BuildSkipped             bool                `json:"buildSkipped"`
	BuildSkippedAvailable    bool                `json:"buildSkippedAvailable"`
	ReconcileRequested       bool                `json:"reconcileRequested"`
	ReconcileOptionAvailable bool                `json:"reconcileOptionAvailable"`
	Calls                    matrixCallReport    `json:"originAndControlCalls"`
	PrepareMS                float64             `json:"prepareMs,omitempty"`
	BuildMS                  float64             `json:"buildMs,omitempty"`
	PrepareBuildMS           float64             `json:"prepareBuildMs,omitempty"`
	StageTimingMode          string              `json:"stageTimingMode"`
	WallMS                   float64             `json:"publishWallMs"`
}

type matrixReport struct {
	SchemaVersion     int                    `json:"schemaVersion"`
	PublisherRevision string                 `json:"publisherRevision"`
	FixtureRoot       string                 `json:"fixtureRoot"`
	Seed              int64                  `json:"seed"`
	OracleTimingMode  string                 `json:"oracleTimingMode"`
	StartedAt         string                 `json:"startedAt"`
	ElapsedMS         float64                `json:"elapsedMs"`
	Datasets          []matrixDatasetReport  `json:"datasets"`
	Scenarios         []matrixScenarioReport `json:"scenarios"`
}

type matrixBackend struct {
	*lockMemoryBackend
	metricsMu sync.Mutex
	metrics   matrixCallReport
	site      string
}

type matrixBackendSnapshot struct {
	objects map[string]Object
	etags   map[string]string
	version uint64
}

func matrixNewBackend(site string) *matrixBackend {
	return &matrixBackend{lockMemoryBackend: newLockMemoryBackend(), site: site, metrics: matrixEmptyCallReport()}
}

func matrixEmptyCallReport() matrixCallReport {
	return matrixCallReport{Counts: make(map[string]int)}
}

func matrixPublishBaseline(t *testing.T, ctx context.Context, siteID, sourceDir string, site registry.Site) *matrixBackend {
	t.Helper()
	backend := matrixNewBackend(siteID)
	projection, err := registry.ProjectSites(map[string]registry.Site{siteID: site})
	if err != nil {
		t.Fatal(err)
	}
	registryBytes, err := registry.Encode(projection)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.lockMemoryBackend.PutObject(ctx, "_indexes/sites.json", Object{Bytes: registryBytes, ContentType: "application/json; charset=utf-8"}); err != nil {
		t.Fatal(err)
	}
	if err := backend.lockMemoryBackend.PutObject(ctx, "_artifacts/neighbor/preserved.txt", Object{Bytes: []byte("neighbor projection sentinel"), ContentType: "text/plain; charset=utf-8"}); err != nil {
		t.Fatal(err)
	}
	if err := backend.lockMemoryBackend.PutObject(ctx, "_indexes/neighbor/index.json", Object{Bytes: []byte("neighbor index sentinel"), ContentType: "application/json; charset=utf-8"}); err != nil {
		t.Fatal(err)
	}
	if err := backend.lockMemoryBackend.PutObject(ctx, "_control/matrix-sentinel", Object{Bytes: []byte("private control sentinel"), ContentType: "application/octet-stream"}); err != nil {
		t.Fatal(err)
	}
	backend.resetMetrics()
	result, err := PublishSite(ctx, backend, SitePublishOptions{SiteID: siteID, SourceDir: sourceDir})
	if err != nil {
		t.Fatalf("seed matrix baseline %s: %v", siteID, err)
	}
	if result.Outcome != "published" {
		t.Fatalf("seed matrix baseline %s outcome=%q, want published", siteID, result.Outcome)
	}
	return backend
}

func matrixCloneBackend(source *matrixBackend) *matrixBackend {
	source.lockMemoryBackend.mu.Lock()
	objects := make(map[string]Object, len(source.objects))
	for key, object := range source.objects {
		objects[key] = matrixCloneObject(object)
	}
	etags := make(map[string]string, len(source.etags))
	for key, etag := range source.etags {
		etags[key] = etag
	}
	version := source.version
	source.lockMemoryBackend.mu.Unlock()
	backend := matrixNewBackend(source.site)
	backend.lockMemoryBackend.objects = objects
	backend.lockMemoryBackend.etags = etags
	backend.lockMemoryBackend.version = version
	return backend
}

func matrixCloneObject(object Object) Object {
	clone := object
	clone.Bytes = append([]byte(nil), object.Bytes...)
	if object.Metadata != nil {
		clone.Metadata = make(map[string]string, len(object.Metadata))
		for key, value := range object.Metadata {
			clone.Metadata[key] = value
		}
	}
	return clone
}

func (backend *matrixBackend) resetMetrics() {
	backend.metricsMu.Lock()
	backend.metrics = matrixEmptyCallReport()
	backend.metricsMu.Unlock()
}

func (backend *matrixBackend) metricsSnapshot(site string) matrixCallReport {
	backend.metricsMu.Lock()
	defer backend.metricsMu.Unlock()
	result := backend.metrics
	result.Counts = make(map[string]int, len(backend.metrics.Counts))
	for method, count := range backend.metrics.Counts {
		result.Counts[method] = count
	}
	return result
}

func (backend *matrixBackend) addMetric(method, keyOrPrefix string, elapsed time.Duration) {
	backend.metricsMu.Lock()
	defer backend.metricsMu.Unlock()
	backend.metrics.Counts[method]++
	if method == "HEAD" && keyOrPrefix == matrixStateKey(backend.site) {
		backend.metrics.StateHeadCalls++
		backend.metrics.StateReadTimeMS += durationMS(elapsed)
	}
	if method == "GET" {
		if keyOrPrefix == matrixStateKey(backend.site) {
			backend.metrics.StateGetCalls++
			backend.metrics.StateReadTimeMS += durationMS(elapsed)
		}
		if matrixContentKey(backend.site, keyOrPrefix) {
			backend.metrics.ProjectionGetCalls++
			backend.metrics.ProjectionReadTimeMS += durationMS(elapsed)
		}
	}
	if method == "HEAD" && matrixContentKey(backend.site, keyOrPrefix) {
		backend.metrics.ProjectionHeadCalls++
		backend.metrics.ProjectionReadTimeMS += durationMS(elapsed)
	}
	if method == "LIST" && matrixContentPrefix(backend.site, keyOrPrefix) {
		backend.metrics.ProjectionListCalls++
		backend.metrics.ProjectionReadTimeMS += durationMS(elapsed)
	}
}

func (backend *matrixBackend) addGetBody(key string, size int64) {
	backend.metricsMu.Lock()
	backend.metrics.GetBodyBytes += size
	if key == matrixStateKey(backend.site) {
		backend.metrics.StateBodyReadBytes += size
	}
	backend.metricsMu.Unlock()
}

func (backend *matrixBackend) addListResult(keys []string, encodedSize int64) {
	backend.metricsMu.Lock()
	backend.metrics.ListedKeys += len(keys)
	backend.metrics.ListJSONBytes += encodedSize
	backend.metricsMu.Unlock()
}

func (backend *matrixBackend) addPutBody(key string, size int64) {
	backend.metricsMu.Lock()
	backend.metrics.PutBodyBytes += size
	if key == matrixStateKey(backend.site) {
		backend.metrics.StatePutCalls++
		backend.metrics.StateBodyWriteBytes += size
	}
	backend.metricsMu.Unlock()
}

func (backend *matrixBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	started := time.Now()
	object, etag, err := backend.lockMemoryBackend.GetObject(ctx, key)
	backend.addMetric("GET", key, time.Since(started))
	if err == nil {
		backend.addGetBody(key, int64(len(object.Bytes)))
	}
	return object, etag, err
}

func (backend *matrixBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	started := time.Now()
	info, err := backend.lockMemoryBackend.HeadObject(ctx, key)
	backend.addMetric("HEAD", key, time.Since(started))
	return info, err
}

func (backend *matrixBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	started := time.Now()
	keys, err := backend.lockMemoryBackend.ListKeys(ctx, prefix)
	backend.addMetric("LIST", prefix, time.Since(started))
	if err == nil {
		encoded, _ := json.Marshal(keys)
		backend.addListResult(keys, int64(len(encoded)))
	}
	return keys, err
}

func (backend *matrixBackend) PutObject(ctx context.Context, key string, object Object) error {
	started := time.Now()
	backend.addPutBody(key, int64(len(object.Bytes)))
	err := backend.lockMemoryBackend.PutObject(ctx, key, object)
	backend.addMetric("PUT", key, time.Since(started))
	return err
}

func (backend *matrixBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	started := time.Now()
	backend.addPutBody(key, int64(len(object.Bytes)))
	etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	backend.addMetric("PUT", key, time.Since(started))
	return etag, err
}

func (backend *matrixBackend) DeleteObjects(ctx context.Context, keys []string) error {
	started := time.Now()
	err := backend.lockMemoryBackend.DeleteObjects(ctx, keys)
	backend.metricsMu.Lock()
	backend.metrics.DeletedKeys += len(keys)
	for _, key := range keys {
		if key == matrixStateKey(backend.site) {
			backend.metrics.StateDeleteCalls++
		}
	}
	backend.metricsMu.Unlock()
	backend.addMetric("DELETE", strings.Join(keys, "\x00"), time.Since(started))
	return err
}

func (backend *matrixBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	started := time.Now()
	id, err := backend.lockMemoryBackend.Invalidate(ctx, paths)
	backend.addMetric("INVALIDATE", "", time.Since(started))
	return id, err
}

func matrixStateKey(site string) string { return "_control/publish-state/" + site + ".json.gz" }

func matrixContentKey(site, key string) bool {
	return strings.HasPrefix(key, "_artifacts/"+site+"/") || strings.HasPrefix(key, "_indexes/"+site+"/")
}

func matrixContentPrefix(site, prefix string) bool {
	return prefix == "_artifacts/"+site+"/" || prefix == "_indexes/"+site+"/"
}

func durationMS(value time.Duration) float64 { return float64(value.Microseconds()) / 1000 }

func matrixCountSource(t *testing.T, root string) matrixSourceProfile {
	t.Helper()
	profile := matrixSourceProfile{}
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("non-regular fixture file %s", name)
		}
		profile.SourceFiles++
		if extIsPage(strings.ToLower(filepath.Ext(name))) {
			profile.Pages++
		} else {
			profile.Resources++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return profile
}

func matrixReadSources(root string) ([]matrixSourceFile, error) {
	var files []matrixSourceFile
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("non-regular fixture file %s", name)
		}
		data, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		files = append(files, matrixSourceFile{
			RelativePath: filepath.ToSlash(relative), Bytes: data,
			Mode: info.Mode().Perm(), ModTime: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].RelativePath < files[j].RelativePath })
	return files, nil
}

func matrixSourcesDigest(files []matrixSourceFile) string {
	hash := sha256.New()
	for _, file := range files {
		fmt.Fprintf(hash, "%s\x00%d\x00", file.RelativePath, len(file.Bytes))
		digest := sha256.Sum256(file.Bytes)
		hash.Write(digest[:])
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func matrixSHA256Hex(data []byte) string {
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:])
}

func matrixSelectedSizes(raw string) ([]int, error) {
	all := []int{10, 100, 1000, 5000, 10000}
	if strings.TrimSpace(raw) == "" {
		return all, nil
	}
	allowed := make(map[int]struct{}, len(all))
	for _, size := range all {
		allowed[size] = struct{}{}
	}
	selected := make([]int, 0)
	seen := make(map[int]struct{})
	for _, part := range strings.Split(raw, ",") {
		var size int
		if _, err := fmt.Sscanf(strings.TrimSpace(part), "%d", &size); err != nil {
			return nil, fmt.Errorf("invalid matrix size %q: %w", part, err)
		}
		if _, ok := allowed[size]; !ok {
			return nil, fmt.Errorf("unsupported matrix size %d", size)
		}
		if _, ok := seen[size]; ok {
			continue
		}
		seen[size] = struct{}{}
		selected = append(selected, size)
	}
	return selected, nil
}

func matrixCoreScenarios(size int) []matrixScenarioSpec {
	type rate struct {
		label string
		count int
	}
	rates := []rate{
		{label: "0%", count: 0},
		{label: "single-file", count: 1},
		{label: "0.1%", count: max(1, int(math.Round(float64(size)*0.001)))},
		{label: "1%", count: max(1, int(math.Round(float64(size)*0.01)))},
		{label: "10%", count: max(1, int(math.Round(float64(size)*0.10)))},
		{label: "100%", count: size},
	}
	order := make([]int, 0, len(rates))
	labels := make(map[int][]string)
	for _, current := range rates {
		if _, ok := labels[current.count]; !ok {
			order = append(order, current.count)
		}
		labels[current.count] = append(labels[current.count], current.label)
	}
	sort.Ints(order)
	var scenarios []matrixScenarioSpec
	for _, count := range order {
		distributions := []string{"uniform-scattered", "clustered", "skewed-80-subtree"}
		if count == 0 {
			distributions = []string{"none"}
		} else if count == size {
			distributions = []string{"all"}
		}
		for _, distribution := range distributions {
			label := strings.Join(labels[count], "+")
			name := fmt.Sprintf("mixed-%s-%s", label, distribution)
			scenarios = append(scenarios, matrixScenarioSpec{
				Name: name, Kind: "page-and-resource-mixed", RateLabels: append([]string(nil), labels[count]...),
				Distribution: distribution, Count: count,
			})
		}
	}
	return scenarios
}

type matrixChangedTypes struct{ Pages, Resources int }

func matrixMutateSources(root string, sources []matrixSourceFile, spec matrixScenarioSpec, size int) ([]string, int64, int64, matrixChangedTypes, error) {
	var selected []string
	if spec.Kind == "resource-only" {
		selected = matrixSelectSourcePaths(sources, spec.Count, "uniform-scattered", fmt.Sprintf("%d/%s", sitePublishMatrixSeed, spec.Name), "resource")
	} else if spec.Kind == "page-mixed" {
		selected = matrixSelectPageMixed(sources, spec.Count, fmt.Sprintf("%d/%s", sitePublishMatrixSeed, spec.Name))
	} else {
		selected = matrixSelectSourcePaths(sources, spec.Count, spec.Distribution, fmt.Sprintf("%d/%s", sitePublishMatrixSeed, spec.Name), "all")
	}
	before := make(map[string]matrixSourceFile, len(sources))
	for _, source := range sources {
		before[source.RelativePath] = source
	}
	var oldBytes int64
	var newBytes int64
	changedTypes := matrixChangedTypes{}
	for index, relative := range selected {
		original, ok := before[relative]
		if !ok {
			return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("selected path %q is not in source snapshot", relative)
		}
		filename := filepath.Join(root, filepath.FromSlash(relative))
		mutation := []byte(fmt.Sprintf("\nMATRIX:%s:%05d\n", spec.Name, index))
		if extIsPage(strings.ToLower(filepath.Ext(relative))) {
			if strings.EqualFold(filepath.Ext(relative), ".html") || strings.EqualFold(filepath.Ext(relative), ".htm") {
				mutation = []byte(fmt.Sprintf("\n<!-- MATRIX:%s:%05d -->\n", spec.Name, index))
			} else {
				mutation = []byte(fmt.Sprintf("\nMatrix verification update %s %05d.\n", spec.Name, index))
			}
		}
		updated := append(append([]byte(nil), original.Bytes...), mutation...)
		if err := os.WriteFile(filename, updated, original.Mode); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		mtime := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(index+1) * time.Second)
		if err := os.Chtimes(filename, mtime, mtime); err != nil {
			return nil, 0, 0, matrixChangedTypes{}, err
		}
		oldBytes += int64(len(original.Bytes))
		newBytes += int64(len(updated))
		if extIsPage(strings.ToLower(filepath.Ext(relative))) {
			changedTypes.Pages++
		} else {
			changedTypes.Resources++
		}
	}
	actual, err := matrixReadSources(root)
	if err != nil {
		return nil, 0, 0, matrixChangedTypes{}, err
	}
	changedPaths := matrixChangedPathList(sources, actual)
	if len(changedPaths) != len(selected) {
		return nil, 0, 0, matrixChangedTypes{}, fmt.Errorf("actual changed path count %d does not match selected count %d", len(changedPaths), len(selected))
	}
	return changedPaths, oldBytes, newBytes, changedTypes, nil
}

func matrixSelectPageMixed(sources []matrixSourceFile, count int, seed string) []string {
	if count <= 0 {
		return nil
	}
	pageFiles, resourceFiles := matrixPartition(sources)
	if len(pageFiles) == 0 || len(resourceFiles) == 0 {
		return matrixSelectSourcePaths(sources, count, "uniform-scattered", seed, "all")
	}
	pageCount := max(1, int(math.Round(float64(count)*0.20)))
	if pageCount >= count {
		pageCount = count - 1
	}
	if pageCount < 1 {
		pageCount = 1
	}
	resourceCount := count - pageCount
	selected := append(matrixPickUniform(pageFiles, pageCount, seed+"/pages"), matrixPickUniform(resourceFiles, resourceCount, seed+"/resources")...)
	sort.Strings(selected)
	return selected
}

func matrixSelectSourcePaths(sources []matrixSourceFile, count int, distribution, seed, kind string) []string {
	_, resources := matrixPartition(sources)
	candidates := make([]string, 0, len(sources))
	switch kind {
	case "resource":
		candidates = append(candidates, resources...)
	default:
		for _, source := range sources {
			candidates = append(candidates, source.RelativePath)
		}
	}
	if count <= 0 {
		return nil
	}
	if count > len(candidates) {
		count = len(candidates)
	}
	switch distribution {
	case "all":
		return append([]string(nil), candidates...)
	case "none":
		return nil
	case "clustered":
		return matrixPickCluster(candidates, count, seed)
	case "skewed-80-subtree":
		target := int(math.Ceil(float64(count) * 0.80))
		subtree, rest := matrixSelectSubtree(candidates, target, seed)
		selected := append(subtree, matrixPickUniform(rest, count-len(subtree), seed+"/outside")...)
		sort.Strings(selected)
		return selected
	default:
		return matrixPickUniform(candidates, count, seed)
	}
}

func matrixPartition(sources []matrixSourceFile) ([]string, []string) {
	var pages, resources []string
	for _, source := range sources {
		if extIsPage(strings.ToLower(filepath.Ext(source.RelativePath))) {
			pages = append(pages, source.RelativePath)
		} else {
			resources = append(resources, source.RelativePath)
		}
	}
	return pages, resources
}

func matrixPickUniform(candidates []string, count int, seed string) []string {
	if count <= 0 {
		return nil
	}
	ordered := append([]string(nil), candidates...)
	sort.Slice(ordered, func(i, j int) bool {
		a, b := matrixScore(seed, ordered[i]), matrixScore(seed, ordered[j])
		if a == b {
			return ordered[i] < ordered[j]
		}
		return a < b
	})
	if count > len(ordered) {
		count = len(ordered)
	}
	selected := append([]string(nil), ordered[:count]...)
	sort.Strings(selected)
	return selected
}

func matrixPickCluster(candidates []string, count int, seed string) []string {
	if count <= 0 {
		return nil
	}
	groups := matrixDirectoryGroups(candidates)
	var eligible []string
	bestDepth := -1
	for directory, members := range groups {
		if len(members) < count {
			continue
		}
		depth := strings.Count(directory, "/") + 1
		if depth > bestDepth {
			eligible = eligible[:0]
			bestDepth = depth
		}
		if depth == bestDepth {
			eligible = append(eligible, directory)
		}
	}
	if len(eligible) == 0 {
		return matrixPickUniform(candidates, count, seed)
	}
	sort.Slice(eligible, func(i, j int) bool {
		a, b := matrixScore(seed, eligible[i]), matrixScore(seed, eligible[j])
		if a == b {
			return eligible[i] < eligible[j]
		}
		return a < b
	})
	directory := eligible[0]
	return matrixContiguousWindow(groups[directory], count, seed)
}

func matrixSelectSubtree(candidates []string, count int, seed string) ([]string, []string) {
	groups := matrixDirectoryGroups(candidates)
	var eligible []string
	bestDepth := -1
	for directory, members := range groups {
		if len(members) < count {
			continue
		}
		depth := strings.Count(directory, "/") + 1
		if depth > bestDepth {
			eligible = eligible[:0]
			bestDepth = depth
		}
		if depth == bestDepth {
			eligible = append(eligible, directory)
		}
	}
	if len(eligible) == 0 {
		return matrixPickUniform(candidates, count, seed), nil
	}
	sort.Slice(eligible, func(i, j int) bool {
		a, b := matrixScore(seed, eligible[i]), matrixScore(seed, eligible[j])
		if a == b {
			return eligible[i] < eligible[j]
		}
		return a < b
	})
	directory := eligible[0]
	inside := matrixPickUniform(groups[directory], count, seed+"/inside")
	insideSet := make(map[string]struct{}, len(inside))
	for _, name := range inside {
		insideSet[name] = struct{}{}
	}
	outside := make([]string, 0, len(candidates)-len(insideSet))
	for _, name := range candidates {
		if !strings.HasPrefix(name, directory+"/") {
			outside = append(outside, name)
		}
	}
	if len(outside) == 0 && len(inside) < len(candidates) {
		for _, name := range candidates {
			if _, selected := insideSet[name]; !selected {
				outside = append(outside, name)
			}
		}
	}
	return inside, outside
}

func matrixDirectoryGroups(candidates []string) map[string][]string {
	groups := make(map[string][]string)
	for _, name := range candidates {
		directory := path.Dir(name)
		for directory != "." && directory != "" {
			groups[directory] = append(groups[directory], name)
			directory = path.Dir(directory)
		}
	}
	return groups
}

func matrixContiguousWindow(candidates []string, count int, seed string) []string {
	ordered := append([]string(nil), candidates...)
	sort.Strings(ordered)
	if count >= len(ordered) {
		return ordered
	}
	span := len(ordered) - count + 1
	start := int(matrixScore(seed, "start") % uint64(span))
	selected := append([]string(nil), ordered[start:start+count]...)
	sort.Strings(selected)
	return selected
}

func matrixScore(seed, value string) uint64 {
	digest := sha256.Sum256([]byte(seed + "\x00" + value))
	return binary.BigEndian.Uint64(digest[:8])
}

func matrixChangedPathList(before, after []matrixSourceFile) []string {
	beforeByPath := make(map[string]matrixSourceFile, len(before))
	afterByPath := make(map[string]matrixSourceFile, len(after))
	for _, file := range before {
		beforeByPath[file.RelativePath] = file
	}
	for _, file := range after {
		afterByPath[file.RelativePath] = file
	}
	set := make(map[string]struct{})
	for name, old := range beforeByPath {
		current, ok := afterByPath[name]
		if !ok || !reflect.DeepEqual(old.Bytes, current.Bytes) {
			set[name] = struct{}{}
		}
	}
	for name := range afterByPath {
		if _, ok := beforeByPath[name]; !ok {
			set[name] = struct{}{}
		}
	}
	result := make([]string, 0, len(set))
	for name := range set {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func matrixRestoreSources(root string, original []matrixSourceFile, changed []string) error {
	byPath := make(map[string]matrixSourceFile, len(original))
	for _, source := range original {
		byPath[source.RelativePath] = source
	}
	for _, relative := range changed {
		source, ok := byPath[relative]
		if !ok {
			return fmt.Errorf("cannot restore unknown source path %q", relative)
		}
		filename := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.WriteFile(filename, source.Bytes, source.Mode); err != nil {
			return err
		}
		if err := os.Chtimes(filename, source.ModTime, source.ModTime); err != nil {
			return err
		}
	}
	return nil
}

func matrixTouchedDirectories(paths []string) []string {
	set := make(map[string]struct{})
	for _, name := range paths {
		set[path.Dir(name)] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for name := range set {
		result = append(result, name)
	}
	sort.Strings(result)
	return result
}

func matrixFirstSource(files []matrixSourceFile, page bool) matrixSourceFile {
	for _, file := range files {
		if extIsPage(strings.ToLower(filepath.Ext(file.RelativePath))) == page {
			return file
		}
	}
	return matrixSourceFile{}
}

func matrixProjectionSnapshot(backend *matrixBackend, site string) map[string]Object {
	backend.lockMemoryBackend.mu.Lock()
	defer backend.lockMemoryBackend.mu.Unlock()
	result := make(map[string]Object)
	for key, object := range backend.objects {
		if matrixContentKey(site, key) {
			result[key] = matrixCloneObject(object)
		}
	}
	return result
}

func matrixObjectDeltas(before, after map[string]Object) []matrixObjectDelta {
	keys := make(map[string]struct{}, len(before)+len(after))
	for key := range before {
		keys[key] = struct{}{}
	}
	for key := range after {
		keys[key] = struct{}{}
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	var changes []matrixObjectDelta
	for _, key := range ordered {
		old, hadOld := before[key]
		current, hasCurrent := after[key]
		switch {
		case !hadOld && hasCurrent:
			changes = append(changes, matrixObjectDelta{Action: "create", Key: key})
		case hadOld && !hasCurrent:
			changes = append(changes, matrixObjectDelta{Action: "remove", Key: key})
		case hadOld && hasCurrent && !reflect.DeepEqual(old, current):
			changes = append(changes, matrixObjectDelta{Action: "update", Key: key})
		}
	}
	return changes
}

func matrixProjectionGeneratedAt(backend *matrixBackend, site string) (time.Time, error) {
	backend.lockMemoryBackend.mu.Lock()
	object, ok := backend.objects["_indexes/"+site+"/index.json"]
	data := append([]byte(nil), object.Bytes...)
	backend.lockMemoryBackend.mu.Unlock()
	if !ok {
		return time.Time{}, fmt.Errorf("site index is missing")
	}
	var index struct {
		GeneratedAt string `json:"generatedAt"`
	}
	if err := json.Unmarshal(data, &index); err != nil {
		return time.Time{}, err
	}
	return time.Parse(time.RFC3339, index.GeneratedAt)
}

func matrixAssertProjectionMatches(t *testing.T, site, scenario string, actual, expected map[string]Object) error {
	t.Helper()
	if len(actual) != len(expected) {
		return fmt.Errorf("%s/%s projection has %d objects; fresh desired projection has %d", site, scenario, len(actual), len(expected))
	}
	for key, want := range expected {
		got, ok := actual[key]
		if !ok {
			return fmt.Errorf("%s/%s projection is missing %q", site, scenario, key)
		}
		if !reflect.DeepEqual(got, want) {
			if len(got.Bytes) <= 2048 && strings.HasSuffix(key, "/meta.json") {
				return fmt.Errorf("%s/%s meta bodies differ: actual=%q expected=%q", site, scenario, got.Bytes, want.Bytes)
			}
			return fmt.Errorf("%s/%s object %q differs from fresh desired projection: bytesEqual=%t actual(type=%q disposition=%q encoding=%q cache=%q metadata=%v bytes=%d) expected(type=%q disposition=%q encoding=%q cache=%q metadata=%v bytes=%d)",
				site, scenario, key, reflect.DeepEqual(got.Bytes, want.Bytes),
				got.ContentType, got.ContentDisposition, got.ContentEncoding, got.Cache, got.Metadata, len(got.Bytes),
				want.ContentType, want.ContentDisposition, want.ContentEncoding, want.Cache, want.Metadata, len(want.Bytes))
		}
	}
	for key := range actual {
		if _, ok := expected[key]; !ok {
			return fmt.Errorf("%s/%s projection has unexpected object %q", site, scenario, key)
		}
	}
	return nil
}

func matrixStableObjectsSnapshot(backend *matrixBackend) map[string]Object {
	keys := []string{
		"_indexes/sites.json",
		"_artifacts/neighbor/preserved.txt",
		"_indexes/neighbor/index.json",
		"_control/matrix-sentinel",
	}
	backend.lockMemoryBackend.mu.Lock()
	defer backend.lockMemoryBackend.mu.Unlock()
	result := make(map[string]Object, len(keys))
	for _, key := range keys {
		if object, ok := backend.objects[key]; ok {
			result[key] = matrixCloneObject(object)
		}
	}
	return result
}

func matrixAssertNeighborAndControlPreserved(t *testing.T, backend *matrixBackend, before map[string]Object) error {
	t.Helper()
	wants := map[string]string{
		"_artifacts/neighbor/preserved.txt": "neighbor projection sentinel",
		"_indexes/neighbor/index.json":      "neighbor index sentinel",
		"_control/matrix-sentinel":          "private control sentinel",
	}
	if len(before) != len(wants)+1 {
		return fmt.Errorf("stable shared-object snapshot has %d entries; want %d", len(before), len(wants)+1)
	}
	backend.lockMemoryBackend.mu.Lock()
	defer backend.lockMemoryBackend.mu.Unlock()
	for key, expected := range wants {
		object, ok := backend.objects[key]
		if !ok || string(object.Bytes) != expected {
			return fmt.Errorf("sentinel %q is missing or changed", key)
		}
	}
	for key, expected := range before {
		actual, ok := backend.objects[key]
		if !ok || !reflect.DeepEqual(actual, expected) {
			return fmt.Errorf("shared registry or neighbor object %q changed", key)
		}
	}
	return nil
}

func matrixSetReconcile(options *SitePublishOptions, enabled bool) bool {
	field := reflect.ValueOf(options).Elem().FieldByName("Reconcile")
	if !field.IsValid() || field.Kind() != reflect.Bool || !field.CanSet() {
		return false
	}
	field.SetBool(enabled)
	return true
}

func matrixResultBuildSkipped(result Result) (bool, bool) {
	field := reflect.ValueOf(result).FieldByName("BuildSkipped")
	if !field.IsValid() || field.Kind() != reflect.Bool {
		return false, false
	}
	return field.Bool(), true
}

func matrixGitRoot(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func matrixGitRevision(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "HEAD")
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

const matrixBuildHelperSource = `package main

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
)

type request struct {
	SiteID string ` + "`json:\"siteId\"`" + `
	Title string ` + "`json:\"title\"`" + `
	Description string ` + "`json:\"description\"`" + `
	SourceDir string ` + "`json:\"sourceDir\"`" + `
	OutputDir string ` + "`json:\"outputDir\"`" + `
	Repository string ` + "`json:\"repository\"`" + `
	RepositoryURL string ` + "`json:\"repositoryUrl\"`" + `
	GeneratedAt string ` + "`json:\"generatedAt\"`" + `
}

type response struct {
	PrepareMS float64 ` + "`json:\"prepareMs\"`" + `
	BuildMS float64 ` + "`json:\"buildMs\"`" + `
	Error string ` + "`json:\"error,omitempty\"`" + `
}

func main() {
	var input request
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil { fail(err) }
	now, err := time.Parse(time.RFC3339, input.GeneratedAt)
	if err != nil { fail(err) }
	options := indexer.BuildOptions{
		SiteID: input.SiteID, SiteTitle: input.Title, SiteDescription: input.Description,
		SourceDir: input.SourceDir, OutputDir: input.OutputDir,
		Repository: input.Repository, RepositoryURL: input.RepositoryURL,
		Now: func() time.Time { return now },
	}
	prepareStart := time.Now()
	prepared, err := indexer.PrepareBuild(context.Background(), options)
	prepareMS := float64(time.Since(prepareStart).Microseconds()) / 1000
	if err != nil { fail(err) }
	buildStart := time.Now()
	_, err = indexer.BuildPrepared(context.Background(), prepared, input.OutputDir)
	buildMS := float64(time.Since(buildStart).Microseconds()) / 1000
	if err != nil { fail(err) }
	if err := json.NewEncoder(os.Stdout).Encode(response{PrepareMS: prepareMS, BuildMS: buildMS}); err != nil { fail(err) }
}

func fail(err error) {
	_ = json.NewEncoder(os.Stdout).Encode(response{Error: err.Error()})
	os.Exit(1)
}
`

type matrixOracleBuilder struct {
	binary     string
	timingMode string
}

func matrixBuildOracleForRevision(t *testing.T, root, work string) (matrixOracleBuilder, error) {
	t.Helper()
	prepareFile := filepath.Join(root, "cli", "internal", "indexer", "prepare.go")
	if _, err := os.Stat(prepareFile); err != nil {
		return matrixOracleBuilder{timingMode: "legacy-build-combined"}, nil
	}
	helperDir := filepath.Join(work, "stage-helper")
	if err := os.MkdirAll(helperDir, 0o700); err != nil {
		return matrixOracleBuilder{}, err
	}
	sourcePath := filepath.Join(helperDir, "main.go")
	if err := os.WriteFile(sourcePath, []byte(matrixBuildHelperSource), 0o600); err != nil {
		return matrixOracleBuilder{}, err
	}
	binaryPath := filepath.Join(helperDir, "matrix-build-oracle")
	command := exec.Command("go", "build", "-trimpath", "-o", binaryPath, sourcePath)
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		return matrixOracleBuilder{}, fmt.Errorf("build prepared-stage oracle: %w\n%s", err, output)
	}
	return matrixOracleBuilder{binary: binaryPath, timingMode: "prepared-stage-split"}, nil
}

func matrixBuildDesiredProjection(ctx context.Context, t *testing.T, oracle matrixOracleBuilder, root, work, sourceDir, siteID string, site registry.Site, identity indexer.GitSourceIdentity, generatedAt time.Time, actual map[string]Object) (map[string]Object, matrixStageTimes, error) {
	t.Helper()
	outputDir, err := os.MkdirTemp(work, "desired-projection-")
	if err != nil {
		return nil, matrixStageTimes{}, err
	}
	defer os.RemoveAll(outputDir)
	options := indexer.BuildOptions{
		SiteID: siteID, SiteTitle: site.Name, SiteDescription: site.Description,
		SourceDir: sourceDir, OutputDir: outputDir, Repository: identity.Repository,
		RepositoryURL: identity.RepositoryURL, Now: func() time.Time { return generatedAt },
	}
	times := matrixStageTimes{Mode: oracle.timingMode}
	if oracle.binary != "" {
		request := map[string]any{
			"siteId": siteID, "title": site.Name, "description": site.Description,
			"sourceDir": sourceDir, "outputDir": outputDir,
			"repository": identity.Repository, "repositoryUrl": identity.RepositoryURL,
			"generatedAt": generatedAt.UTC().Format(time.RFC3339),
		}
		input, err := json.Marshal(request)
		if err != nil {
			return nil, times, err
		}
		command := exec.CommandContext(ctx, oracle.binary)
		command.Dir = root
		command.Stdin = strings.NewReader(string(input))
		output, err := command.CombinedOutput()
		if err != nil {
			return nil, times, fmt.Errorf("prepared-stage oracle: %w: %s", err, strings.TrimSpace(string(output)))
		}
		var measured struct {
			PrepareMS float64 `json:"prepareMs"`
			BuildMS   float64 `json:"buildMs"`
			Error     string  `json:"error"`
		}
		if err := json.Unmarshal(output, &measured); err != nil {
			return nil, times, err
		}
		if measured.Error != "" {
			return nil, times, fmt.Errorf("prepared-stage oracle: %s", measured.Error)
		}
		times.PrepareMS, times.BuildMS = measured.PrepareMS, measured.BuildMS
	} else {
		started := time.Now()
		if _, err := indexer.Build(ctx, options); err != nil {
			return nil, times, err
		}
		times.PrepareBuildMS = durationMS(time.Since(started))
	}
	expected := make(map[string]Object)
	sources, err := matrixReadSources(sourceDir)
	if err != nil {
		return nil, times, err
	}
	for _, source := range sources {
		key := "_artifacts/" + siteID + "/" + source.RelativePath
		expected[key] = Object{
			Bytes: append([]byte(nil), source.Bytes...), ContentType: contentType(source.RelativePath),
			ContentDisposition: "inline", Cache: artifactCacheControl,
			Metadata: map[string]string{"artifact-pages-site": siteID, "artifact-pages-sha256": matrixSHA256Hex(source.Bytes)},
		}
	}
	indexRoot := filepath.Join(outputDir, "_indexes", siteID)
	err = filepath.WalkDir(indexRoot, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("generated index output is not regular: %s", name)
		}
		data, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(indexRoot, name)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		contentType, cache := "application/json; charset=utf-8", indexCacheControl
		if strings.HasSuffix(relative, ".gz") {
			contentType, cache = "application/octet-stream", immutableCache
		}
		key := "_indexes/" + siteID + "/" + relative
		if (relative == "index.json" || relative == "meta.json") && actual[key].Bytes != nil && matrixSameGeneratedProjection(actual[key].Bytes, data) {
			// generatedAt is intentionally volatile, and the publisher may
			// preserve index.json and meta.json timestamps independently.
			// Reuse the observed timestamp only after the fresh projection
			// matches all other JSON fields.
			data = append([]byte(nil), actual[key].Bytes...)
		}
		expected[key] = Object{
			Bytes: data, ContentType: contentType, ContentDisposition: "inline", Cache: cache,
			Metadata: map[string]string{"artifact-pages-site": siteID, "artifact-pages-sha256": matrixSHA256Hex(data)},
		}
		return nil
	})
	if err != nil {
		return nil, times, err
	}
	return expected, times, nil
}

func matrixSameGeneratedProjection(current, desired []byte) bool {
	var currentValue map[string]json.RawMessage
	var desiredValue map[string]json.RawMessage
	if json.Unmarshal(current, &currentValue) != nil || json.Unmarshal(desired, &desiredValue) != nil {
		return false
	}
	delete(currentValue, "generatedAt")
	delete(desiredValue, "generatedAt")
	currentJSON, currentErr := json.Marshal(currentValue)
	desiredJSON, desiredErr := json.Marshal(desiredValue)
	return currentErr == nil && desiredErr == nil && string(currentJSON) == string(desiredJSON)
}
