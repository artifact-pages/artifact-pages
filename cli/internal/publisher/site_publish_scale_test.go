package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/indexer"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
)

// TestSitePublishScaleProbe is an opt-in measurement harness for the real
// provider-neutral PublishSite flow. It uses the same seeded source and object
// state across revisions; the backend counts object API calls and payload bytes
// without adding synthetic sleeps. Set ARTIFACT_PAGES_SCALE_SOURCE and
// ARTIFACT_PAGES_SCALE_SITE to enable it.
func TestSitePublishScaleProbe(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_SCALE_SOURCE") == "" {
		t.Skip("set ARTIFACT_PAGES_SCALE_SOURCE to run the publish scale probe")
	}
	ctx := context.Background()
	root, err := scaleProbeGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	source := os.Getenv("ARTIFACT_PAGES_SCALE_SOURCE")
	if !filepath.IsAbs(source) {
		source = filepath.Join(root, source)
	}
	source, err = filepath.Abs(source)
	if err != nil {
		t.Fatal(err)
	}
	siteID := os.Getenv("ARTIFACT_PAGES_SCALE_SITE")
	if siteID == "" {
		siteID = strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))
	}
	profile := siteScaleProfile(t, source)

	localRoot := filepath.Join(root, ".local")
	if err := os.MkdirAll(localRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(localRoot, "publish-scale-probe-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(work)
	workSource := filepath.Join(work, "source")
	if err := copyScaleTree(source, workSource); err != nil {
		t.Fatal(err)
	}
	identity, err := indexer.ResolveGitSourceIdentity(ctx, workSource)
	if err != nil {
		t.Fatal(err)
	}
	backend := newSitePublishScaleBackend()
	site := registry.Site{Name: "Verification " + siteID, Description: "Deterministic publish verification fixture", Repository: identity.Repository, SourcePath: identity.SourcePath}
	seedScaleRegistry(t, backend.lockMemoryBackend, siteID, site)
	seedMemoryObject(backend.lockMemoryBackend, "_artifacts/neighbor/probe.txt", []byte("preserve neighboring site"))
	seedMemoryObject(backend.lockMemoryBackend, "_control/private/sentinel", []byte("preserve private control data"))

	options := SitePublishOptions{SiteID: siteID, SourceDir: workSource}
	phases := make([]sitePublishScalePhase, 0, 12)
	phases = append(phases, runSitePublishScalePhase(t, backend, "initial", options, false))
	phases = append(phases, runSitePublishScalePhase(t, backend, "no-op", options, false))
	phases = append(phases, runSitePublishScalePhase(t, backend, "dry-run-no-op", SitePublishOptions{SiteID: siteID, SourceDir: workSource, DryRun: true}, false))

	pagePath := firstScaleFile(t, workSource, func(name string) bool {
		ext := strings.ToLower(filepath.Ext(name))
		return extIsPage(ext)
	})
	resourcePath := firstScaleFile(t, workSource, func(name string) bool {
		ext := strings.ToLower(filepath.Ext(name))
		return !extIsPage(ext)
	})
	resourceDir := filepath.Dir(resourcePath)
	originalPage, err := os.ReadFile(pagePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pagePath, append(append([]byte(nil), originalPage...), []byte("\n<!-- verification small update -->\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resourceDir, "scale-added.css"), []byte("/* deterministic add */\nbody { --scale-added: 1; }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(resourcePath); err != nil {
		t.Fatal(err)
	}
	phases = append(phases, runSitePublishScalePhase(t, backend, "small-update-add-remove", options, false))
	recoveryResourcePath := firstScaleFile(t, workSource, func(name string) bool {
		return !extIsPage(strings.ToLower(filepath.Ext(name)))
	})
	recoveryResource, err := os.ReadFile(recoveryResourcePath)
	if err != nil {
		t.Fatal(err)
	}

	site.Name += " · metadata change"
	site.Description += " with changed registry metadata"
	seedScaleRegistry(t, backend.lockMemoryBackend, siteID, site)
	phases = append(phases, runSitePublishScalePhase(t, backend, "metadata-only", options, false))

	fullTextOptions := options
	phases = append(phases, runSitePublishScalePhase(t, backend, "fulltext-on", fullTextOptions, false))
	fullTextStateRaw, fullTextStateGzip := scaleStateSizes(backend, siteID)
	phases = append(phases, runSitePublishScalePhase(t, backend, "fulltext-off", options, false))

	if err := os.WriteFile(pagePath, append(append([]byte(nil), originalPage...), []byte("\n<!-- interrupted generation -->\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resourceDir, "interrupted-a.css"), []byte("/* interrupted A */\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resourceDir, "interrupted-b.css"), []byte("/* interrupted B */\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(recoveryResourcePath); err != nil {
		t.Fatal(err)
	}
	backend.setFailAfterArtifactPuts(1)
	phases = append(phases, runSitePublishScalePhase(t, backend, "interrupted-write", options, true))
	if err := os.WriteFile(pagePath, originalPage, 0o600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"interrupted-a.css", "interrupted-b.css"} {
		if err := os.Remove(filepath.Join(resourceDir, name)); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(recoveryResourcePath, recoveryResource, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(resourceDir, "recovered-latest.css"), []byte("/* latest desired source */\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	phases = append(phases, runSitePublishScalePhase(t, backend, "retry-with-different-source", options, false))

	// Recreate the pre-state manifestless condition while keeping the published
	// projection. This exercises legacy inventory migration before/after the
	// manifest optimization without changing the source corpus.
	backend.mu.Lock()
	delete(backend.objects, sitePublishScaleStateKey(siteID))
	delete(backend.etags, sitePublishScaleStateKey(siteID))
	backend.mu.Unlock()
	phases = append(phases, runSitePublishScalePhase(t, backend, "legacy-migration", options, false))

	stateRaw, stateGzip := scaleStateSizes(backend, siteID)
	finalObjects := backend.siteProjectionSnapshot(siteID)
	neighborOK := backend.objectBytes("_artifacts/neighbor/probe.txt") == "preserve neighboring site" && backend.objectBytes("_control/private/sentinel") == "preserve private control data"
	revision, err := scaleProbeGitRevision(ctx)
	if err != nil {
		t.Fatal(err)
	}
	final := sitePublishScaleReport{
		SourceRevision: revision,
		Site:           siteID, SourceFiles: profile.SourceFiles, Pages: profile.Pages, Resources: profile.Resources,
		Phases: phases, PublishStateRawBytes: stateRaw, PublishStateGzipBytes: stateGzip,
		FullTextOnPublishStateRawBytes: fullTextStateRaw, FullTextOnPublishStateGzipBytes: fullTextStateGzip,
		FinalProjectionObjects: finalObjects, NeighborAndControlPreserved: neighborOK,
		ModeledFixedRequestLatencyMS: 10,
	}
	encoded, err := json.Marshal(final)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("SITE_PUBLISH_SCALE_JSON=%s", encoded)
}

type sitePublishScaleProfile struct {
	SourceFiles int `json:"sourceFiles"`
	Pages       int `json:"pages"`
	Resources   int `json:"resources"`
}

func siteScaleProfile(t *testing.T, root string) sitePublishScaleProfile {
	t.Helper()
	profile := sitePublishScaleProfile{}
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("scale source contains non-regular entry %s", name)
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

func extIsPage(ext string) bool { return ext == ".html" || ext == ".htm" || ext == ".md" }

func firstScaleFile(t *testing.T, root string, accept func(string) bool) string {
	t.Helper()
	var matches []string
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		if entry.Type().IsRegular() && accept(name) {
			matches = append(matches, name)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(matches)
	if len(matches) == 0 {
		t.Fatal("scale source has no matching file")
	}
	return matches[0]
}

func copyScaleTree(source, destination string) error {
	return filepath.WalkDir(source, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, name)
		if err != nil {
			return err
		}
		if relative == "." {
			return os.MkdirAll(destination, 0o700)
		}
		target := filepath.Join(destination, relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("scale source contains non-regular entry %s", name)
		}
		data, err := os.ReadFile(name)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.WriteFile(target, data, info.Mode().Perm()); err != nil {
			return err
		}
		return os.Chtimes(target, info.ModTime(), info.ModTime())
	})
}

func scaleProbeGitRoot(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "--show-toplevel")
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func scaleProbeGitRevision(ctx context.Context) (string, error) {
	command := exec.CommandContext(ctx, "git", "rev-parse", "HEAD")
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func seedScaleRegistry(t *testing.T, backend *lockMemoryBackend, siteID string, site registry.Site) {
	t.Helper()
	projection, err := registry.ProjectSites(map[string]registry.Site{siteID: site})
	if err != nil {
		t.Fatal(err)
	}
	data, err := registry.Encode(projection)
	if err != nil {
		t.Fatal(err)
	}
	seedMemoryObject(backend, "_indexes/sites.json", data)
}

type sitePublishScalePhase struct {
	Name         string         `json:"name"`
	Outcome      string         `json:"outcome,omitempty"`
	BuildSkipped bool           `json:"buildSkipped,omitempty"`
	Error        string         `json:"error,omitempty"`
	WallMS       float64        `json:"wallMs"`
	CallCounts   map[string]int `json:"callCounts"`
	BytesRead    int64          `json:"bytesReadGetBodies"`
	BytesList    int64          `json:"bytesReturnedByList"`
	BytesWrite   int64          `json:"bytesWrittenPutBodies"`
	ModeledMS    int64          `json:"modeledFixedRequestLatencyMs"`
}

type sitePublishScaleReport struct {
	SourceRevision                  string                  `json:"sourceRevision"`
	Site                            string                  `json:"site"`
	SourceFiles                     int                     `json:"sourceFiles"`
	Pages                           int                     `json:"pages"`
	Resources                       int                     `json:"resources"`
	Phases                          []sitePublishScalePhase `json:"phases"`
	PublishStateRawBytes            int                     `json:"publishStateRawBytes,omitempty"`
	PublishStateGzipBytes           int                     `json:"publishStateGzipBytes,omitempty"`
	FullTextOnPublishStateRawBytes  int                     `json:"fullTextOnPublishStateRawBytes,omitempty"`
	FullTextOnPublishStateGzipBytes int                     `json:"fullTextOnPublishStateGzipBytes,omitempty"`
	FinalProjectionObjects          int                     `json:"finalProjectionObjects"`
	NeighborAndControlPreserved     bool                    `json:"neighborAndControlPreserved"`
	ModeledFixedRequestLatencyMS    int                     `json:"modeledFixedRequestLatencyMs"`
}

func runSitePublishScalePhase(t *testing.T, backend *sitePublishScaleBackend, name string, options SitePublishOptions, wantError bool) sitePublishScalePhase {
	t.Helper()
	backend.resetCounts()
	started := time.Now()
	result, err := PublishSite(context.Background(), backend, options)
	wall := time.Since(started)
	if wantError {
		if err == nil {
			t.Fatalf("%s PublishSite() error = nil, want injected interruption", name)
		}
	} else if err != nil {
		t.Fatalf("%s PublishSite() error = %v", name, err)
	}
	counts, bytesRead, bytesList, bytesWritten := backend.countSnapshot()
	requestCount := 0
	for _, count := range counts {
		requestCount += count
	}
	phase := sitePublishScalePhase{
		Name: name, WallMS: float64(wall.Microseconds()) / 1000,
		CallCounts: counts, BytesRead: bytesRead, BytesList: bytesList, BytesWrite: bytesWritten,
		ModeledMS: int64(requestCount * 10),
	}
	if err != nil {
		phase.Error = err.Error()
	} else {
		phase.Outcome = result.Outcome
		phase.BuildSkipped = result.BuildSkipped
	}
	return phase
}

func sitePublishScaleStateKey(site string) string {
	return "_control/publish-state/" + site + ".json.gz"
}

func scaleStateSizes(backend *sitePublishScaleBackend, site string) (int, int) {
	backend.mu.Lock()
	object, exists := backend.objects[sitePublishScaleStateKey(site)]
	data := append([]byte(nil), object.Bytes...)
	backend.mu.Unlock()
	if !exists {
		return 0, 0
	}
	plain, err := decompressSitePublishState(data)
	if err != nil {
		return 0, len(data)
	}
	return len(plain), len(data)
}

type sitePublishScaleBackend struct {
	*lockMemoryBackend
	countMu                 sync.Mutex
	counts                  map[string]int
	bytesRead               int64
	bytesList               int64
	bytesWritten            int64
	failAfterArtifactPuts   int
	artifactPutsBeforeError int
}

func newSitePublishScaleBackend() *sitePublishScaleBackend {
	return &sitePublishScaleBackend{lockMemoryBackend: newLockMemoryBackend(), counts: make(map[string]int)}
}

func (backend *sitePublishScaleBackend) resetCounts() {
	backend.countMu.Lock()
	backend.counts = make(map[string]int)
	backend.bytesRead = 0
	backend.bytesList = 0
	backend.bytesWritten = 0
	backend.countMu.Unlock()
}

func (backend *sitePublishScaleBackend) countSnapshot() (map[string]int, int64, int64, int64) {
	backend.countMu.Lock()
	defer backend.countMu.Unlock()
	counts := make(map[string]int, len(backend.counts))
	for name, value := range backend.counts {
		counts[name] = value
	}
	return counts, backend.bytesRead, backend.bytesList, backend.bytesWritten
}

func (backend *sitePublishScaleBackend) recordRequest(name string) {
	backend.countMu.Lock()
	backend.counts[name]++
	backend.countMu.Unlock()
}

func (backend *sitePublishScaleBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	backend.recordRequest("GET")
	object, etag, err := backend.lockMemoryBackend.GetObject(ctx, key)
	if err == nil {
		backend.countMu.Lock()
		backend.bytesRead += int64(len(object.Bytes))
		backend.countMu.Unlock()
	}
	return object, etag, err
}

func (backend *sitePublishScaleBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	backend.recordRequest("HEAD")
	return backend.lockMemoryBackend.HeadObject(ctx, key)
}

func (backend *sitePublishScaleBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	backend.recordRequest("LIST")
	keys, err := backend.lockMemoryBackend.ListKeys(ctx, prefix)
	if err == nil {
		data, _ := json.Marshal(keys)
		backend.countMu.Lock()
		backend.bytesList += int64(len(data))
		backend.countMu.Unlock()
	}
	return keys, err
}

func (backend *sitePublishScaleBackend) PutObject(ctx context.Context, key string, object Object) error {
	backend.recordRequest("PUT")
	backend.countMu.Lock()
	backend.bytesWritten += int64(len(object.Bytes))
	failPut := false
	if strings.HasPrefix(key, "_artifacts/") && backend.failAfterArtifactPuts > 0 {
		backend.artifactPutsBeforeError++
		if backend.artifactPutsBeforeError > backend.failAfterArtifactPuts {
			backend.failAfterArtifactPuts = 0
			backend.artifactPutsBeforeError = 0
			failPut = true
		}
	}
	backend.countMu.Unlock()
	if failPut {
		return errors.New("injected publish interruption after partial artifact upload")
	}
	return backend.lockMemoryBackend.PutObject(ctx, key, object)
}

func (backend *sitePublishScaleBackend) setFailAfterArtifactPuts(successfulPuts int) {
	backend.countMu.Lock()
	backend.failAfterArtifactPuts = successfulPuts
	backend.artifactPutsBeforeError = 0
	backend.countMu.Unlock()
}

func (backend *sitePublishScaleBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.recordRequest("PUT")
	backend.countMu.Lock()
	backend.bytesWritten += int64(len(object.Bytes))
	backend.countMu.Unlock()
	return backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
}

func (backend *sitePublishScaleBackend) DeleteObjects(ctx context.Context, keys []string) error {
	backend.recordRequest("DELETE")
	return backend.lockMemoryBackend.DeleteObjects(ctx, keys)
}

func (backend *sitePublishScaleBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	backend.recordRequest("INVALIDATE")
	return backend.lockMemoryBackend.Invalidate(ctx, paths)
}

func (backend *sitePublishScaleBackend) objectBytes(key string) string {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return string(backend.objects[key].Bytes)
}

func (backend *sitePublishScaleBackend) siteProjectionSnapshot(site string) int {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	count := 0
	for key := range backend.objects {
		if strings.HasPrefix(key, "_artifacts/"+site+"/") || strings.HasPrefix(key, "_indexes/"+site+"/") {
			count++
		}
	}
	return count
}
