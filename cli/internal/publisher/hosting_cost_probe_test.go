package publisher

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

// TestHostingCostProbe is an opt-in counting-adapter measurement for the T27
// launch cost model. It records provider-neutral object operations and exact
// object-body bytes for bootstrap, no-op, and one-document-change publishes.
// It intentionally does not model SDK retries, S3 pagination, HTTP framing, or
// provider billing logs.
func TestHostingCostProbe(t *testing.T) {
	source := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_HOSTING_COST_SOURCE"))
	if source == "" {
		t.Skip("set ARTIFACT_PAGES_HOSTING_COST_SOURCE to run the hosting cost probe")
	}
	ctx := context.Background()
	root, err := scaleProbeGitRoot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(source) {
		source = filepath.Join(root, source)
	}
	source, err = filepath.Abs(source)
	if err != nil {
		t.Fatal(err)
	}
	siteID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_HOSTING_COST_SITE"))
	if siteID == "" {
		siteID = strings.TrimSuffix(filepath.Base(source), filepath.Ext(source))
	}

	localRoot := filepath.Join(root, ".local")
	if err := os.MkdirAll(localRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	work, err := os.MkdirTemp(localRoot, "hosting-cost-probe-")
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
	profile := siteScaleProfile(t, workSource)
	var sourceBytes int64
	if err := filepath.WalkDir(workSource, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		sourceBytes += info.Size()
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	backend := newSitePublishScaleBackend()
	provider := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_HOSTING_COST_PROVIDER"))
	if provider == "" {
		provider = "plain"
	}
	if provider != "plain" && provider != "aws" {
		t.Fatalf("unsupported ARTIFACT_PAGES_HOSTING_COST_PROVIDER %q (want plain or aws)", provider)
	}
	var publishBackend DeploymentBackend = backend
	if provider == "aws" {
		publishBackend = &hostingCostAWSBackend{sitePublishScaleBackend: backend}
	}
	site := registry.Site{
		Name: "Hosting cost " + siteID, Description: "T27 generated measurement fixture",
		Repository: identity.Repository, SourcePath: identity.SourcePath,
	}
	seedScaleRegistry(t, backend.lockMemoryBackend, siteID, site)
	options := SitePublishOptions{SiteID: siteID, SourceDir: workSource}
	phases := []hostingCostProbePhase{
		runHostingCostProbePhase(t, publishBackend, backend, options, "first publish"),
		runHostingCostProbePhase(t, publishBackend, backend, options, "no-op republish"),
	}

	pagePath := firstScaleFile(t, workSource, func(name string) bool {
		return extIsPage(strings.ToLower(filepath.Ext(name)))
	})
	page, err := os.ReadFile(pagePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pagePath, append(append([]byte(nil), page...), []byte("\n<!-- T27 one-document change -->\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	phases = append(phases, runHostingCostProbePhase(t, publishBackend, backend, options, "one-document change"))

	projectionObjects, projectionBytes, searchObjects, searchBytes := hostingCostStoredObjects(backend, siteID)
	stateRaw, stateGzip := hostingCostStateSizes(backend, siteID)
	objectEvidence := hostingCostObjects(backend, siteID)
	validatedIndex, validatedManifest := false, false
	observedClasses := map[cacheObjectClass]bool{}
	for _, object := range objectEvidence {
		class, ok := sitePublishCacheClass(siteID, object.Key)
		if !ok {
			t.Fatalf("probe object %q has no cache class", object.Key)
		}
		if object.CacheControl != cacheControl(class) {
			t.Fatalf("%s Cache-Control = %q, want %q for %s", object.Key, object.CacheControl, cacheControl(class), class)
		}
		observedClasses[class] = true
		if strings.HasSuffix(object.Key, "/index.json") {
			validatedIndex = object.DecodedJSONValid
			if provider == "aws" && object.ContentEncoding != "gzip" {
				t.Fatalf("AWS site index Content-Encoding = %q, want gzip", object.ContentEncoding)
			}
			if provider == "plain" && object.ContentEncoding != "" {
				t.Fatalf("plain site index Content-Encoding = %q, want identity", object.ContentEncoding)
			}
		}
		if strings.HasSuffix(object.Key, "/manifest.json") {
			validatedManifest = object.DecodedJSONValid
			if provider == "aws" && object.ContentEncoding != "gzip" {
				t.Fatalf("AWS search manifest Content-Encoding = %q, want gzip", object.ContentEncoding)
			}
			if provider == "plain" && object.ContentEncoding != "" {
				t.Fatalf("plain search manifest Content-Encoding = %q, want identity", object.ContentEncoding)
			}
		}
	}
	if !validatedIndex || !validatedManifest {
		t.Fatalf("generated JSON validation failed: index=%t manifest=%t", validatedIndex, validatedManifest)
	}
	if !observedClasses[cacheClassSiteRoot] || !observedClasses[cacheClassSearchManifest] || !observedClasses[cacheClassHashedAsset] || !observedClasses[cacheClassArtifact] {
		t.Fatalf("probe did not exercise required cache classes: %#v", observedClasses)
	}
	policyHeaders := make(map[string]string, len(cacheControlByClass))
	for class, header := range cacheControlByClass {
		policyHeaders[string(class)] = header
	}
	report := struct {
		CachePolicyRevision     string                   `json:"cachePolicyRevision"`
		CachePolicyHeaders      map[string]string        `json:"cachePolicyHeaders"`
		MeasuredAt              string                   `json:"measuredAt"`
		Provider                string                   `json:"provider"`
		SourceRevision          string                   `json:"sourceRevision"`
		Site                    string                   `json:"site"`
		Pages                   int                      `json:"pages"`
		SourceFiles             int                      `json:"sourceFiles"`
		SourceBytes             int64                    `json:"sourceBytes"`
		CounterBoundary         string                   `json:"counterBoundary"`
		Phases                  []hostingCostProbePhase  `json:"phases"`
		StoredProjection        int                      `json:"storedProjectionObjects"`
		StoredProjectionBytes   int64                    `json:"storedProjectionBytes"`
		StoredSearchObjects     int                      `json:"storedSearchObjects"`
		StoredSearchBytes       int64                    `json:"storedSearchBytes"`
		PublishStateRawBytes    int                      `json:"publishStateRawBytes"`
		PublishStateGzipBytes   int                      `json:"publishStateGzipBytes"`
		Objects                 []hostingCostProbeObject `json:"objects"`
		GeneratedJSONValidation map[string]bool          `json:"generatedJSONValidation"`
	}{
		CachePolicyRevision: cachePolicyRevision, CachePolicyHeaders: policyHeaders, MeasuredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Provider:       provider,
		SourceRevision: gitRevisionForHostingCost(t, ctx), Site: siteID,
		Pages: profile.Pages - hostingCostReadmes(workSource), SourceFiles: profile.SourceFiles, SourceBytes: sourceBytes,
		CounterBoundary: "provider-neutral ConditionalObjectBackend methods; LIST is one logical prefix call, DELETE is one logical batch call; no SDK pagination, retries, or wire bytes",
		Phases:          phases, StoredProjection: projectionObjects, StoredProjectionBytes: projectionBytes,
		StoredSearchObjects: searchObjects, StoredSearchBytes: searchBytes,
		PublishStateRawBytes: stateRaw, PublishStateGzipBytes: stateGzip,
		Objects: objectEvidence, GeneratedJSONValidation: map[string]bool{"index": validatedIndex, "manifest": validatedManifest},
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("HOSTING_COST_JSON=%s", encoded)
}

type hostingCostAWSBackend struct{ *sitePublishScaleBackend }

func (*hostingCostAWSBackend) siteGeneratedJSONContentEncoding() string { return "gzip" }

type hostingCostProbeObject struct {
	Key              string `json:"key"`
	StoredBytes      int    `json:"storedBytes"`
	ContentType      string `json:"contentType"`
	ContentEncoding  string `json:"contentEncoding"`
	CacheControl     string `json:"cacheControl"`
	SHA256           string `json:"sha256"`
	DecodedJSONValid bool   `json:"decodedJSONValid"`
}

func hostingCostObjects(backend *sitePublishScaleBackend, siteID string) []hostingCostProbeObject {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	objects := make([]hostingCostProbeObject, 0)
	for key, object := range backend.objects {
		if !strings.HasPrefix(key, "_indexes/"+siteID+"/") && !strings.HasPrefix(key, "_artifacts/"+siteID+"/") {
			continue
		}
		sum := sha256.Sum256(object.Bytes)
		validJSON := false
		if strings.HasSuffix(key, "/index.json") || strings.HasSuffix(key, "/manifest.json") {
			body := object.Bytes
			if object.ContentEncoding == "gzip" {
				reader, err := gzip.NewReader(strings.NewReader(string(body)))
				if err == nil {
					decoded, readErr := io.ReadAll(reader)
					closeErr := reader.Close()
					if readErr == nil && closeErr == nil {
						body = decoded
					} else {
						body = nil
					}
				} else {
					body = nil
				}
			}
			var value any
			validJSON = body != nil && json.Unmarshal(body, &value) == nil
		}
		objects = append(objects, hostingCostProbeObject{Key: key, StoredBytes: len(object.Bytes), ContentType: object.ContentType,
			ContentEncoding: object.ContentEncoding, CacheControl: object.Cache, SHA256: hex.EncodeToString(sum[:]), DecodedJSONValid: validJSON})
	}
	sort.Slice(objects, func(i, j int) bool { return objects[i].Key < objects[j].Key })
	return objects
}

type hostingCostProbePhase struct {
	Name          string         `json:"name"`
	Outcome       string         `json:"outcome"`
	BuildSkipped  bool           `json:"buildSkipped"`
	CallCounts    map[string]int `json:"callCounts"`
	GetBodyBytes  int64          `json:"getBodyBytes"`
	ListJSONBytes int64          `json:"listJSONBytes"`
	PutBodyBytes  int64          `json:"putBodyBytes"`
	WallMS        float64        `json:"wallMs"`
}

func runHostingCostProbePhase(t *testing.T, publishBackend DeploymentBackend, backend *sitePublishScaleBackend, options SitePublishOptions, name string) hostingCostProbePhase {
	t.Helper()
	backend.resetCounts()
	started := time.Now()
	result, err := PublishSite(context.Background(), publishBackend, options)
	wall := time.Since(started)
	if err != nil {
		t.Fatalf("%s: PublishSite() error = %v", name, err)
	}
	counts, getBytes, listBytes, putBytes := backend.countSnapshot()
	return hostingCostProbePhase{
		Name: name, Outcome: result.Outcome, BuildSkipped: result.BuildSkipped,
		CallCounts:   counts,
		GetBodyBytes: getBytes, ListJSONBytes: listBytes,
		PutBodyBytes: putBytes,
		WallMS:       float64(wall.Microseconds()) / 1000,
	}
}

func hostingCostStoredObjects(backend *sitePublishScaleBackend, siteID string) (projectionObjects int, projectionBytes int64, searchObjects int, searchBytes int64) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for key, object := range backend.objects {
		if !strings.HasPrefix(key, "_indexes/"+siteID+"/") && !strings.HasPrefix(key, "_artifacts/"+siteID+"/") {
			continue
		}
		projectionObjects++
		projectionBytes += int64(len(object.Bytes))
		if strings.HasPrefix(key, "_indexes/"+siteID+"/search/") {
			searchObjects++
			searchBytes += int64(len(object.Bytes))
		}
	}
	return projectionObjects, projectionBytes, searchObjects, searchBytes
}

func hostingCostReadmes(root string) int {
	count := 0
	_ = filepath.WalkDir(root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr == nil && !entry.IsDir() && strings.EqualFold(filepath.Base(name), "README.md") {
			count++
		}
		return walkErr
	})
	return count
}

func hostingCostStateSizes(backend *sitePublishScaleBackend, siteID string) (int, int) {
	backend.mu.Lock()
	object, exists := backend.objects[sitePublishStateKey(siteID)]
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

func gitRevisionForHostingCost(t *testing.T, ctx context.Context) string {
	t.Helper()
	revision, err := scaleProbeGitRevision(ctx)
	if err != nil {
		t.Fatal(fmt.Errorf("read hosting-cost probe source revision: %w", err))
	}
	return revision
}
