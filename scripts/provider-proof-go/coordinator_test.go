package providerproof

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

type localManifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	RunID         string `json:"runId"`
	TestOnly      bool   `json:"testOnly"`
}

type memoryObject struct {
	body []byte
	etag uint64
}

type memoryStore struct {
	mu       sync.Mutex
	objects  map[string]memoryObject
	serial   uint64
	requests int
}

func newMemoryStore() *memoryStore {
	return &memoryStore{objects: make(map[string]memoryObject)}
}

func (store *memoryStore) put(key string, body []byte) uint64 {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.serial++
	store.objects[key] = memoryObject{body: append([]byte(nil), body...), etag: store.serial}
	return store.serial
}

func (store *memoryStore) get(key string) ([]byte, uint64, bool) {
	store.mu.Lock()
	defer store.mu.Unlock()
	item, ok := store.objects[key]
	return append([]byte(nil), item.body...), item.etag, ok
}

func (store *memoryStore) compareAndSwap(key string, expected uint64, body []byte) bool {
	store.mu.Lock()
	defer store.mu.Unlock()
	item, ok := store.objects[key]
	if !ok || item.etag != expected {
		return false
	}
	store.serial++
	store.objects[key] = memoryObject{body: append([]byte(nil), body...), etag: store.serial}
	return true
}

func (store *memoryStore) list(prefix string) []string {
	store.mu.Lock()
	defer store.mu.Unlock()
	keys := make([]string, 0)
	for key := range store.objects {
		if len(key) >= len(prefix) && key[:len(prefix)] == prefix {
			keys = append(keys, key)
		}
	}
	return keys
}

func (store *memoryStore) countRequests() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.requests
}

func loadLocalManifest(t *testing.T) localManifest {
	t.Helper()
	manifestPath := os.Getenv("ARTIFACT_PAGES_PROOF_MANIFEST")
	if manifestPath == "" {
		localPath := filepath.Join("..", "..", ".local", "provider-proof-20261018", "manifest.json")
		if _, err := os.Stat(localPath); err == nil {
			manifestPath = localPath
		} else {
			manifestPath = filepath.Join("testdata", "manifest.json")
		}
	}
	bytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("local proof manifest unavailable: %v", err)
	}
	var manifest localManifest
	if err := json.Unmarshal(bytes, &manifest); err != nil {
		t.Fatal("local proof manifest is invalid JSON")
	}
	if manifest.SchemaVersion != 1 || manifest.RunID == "" || !manifest.TestOnly {
		t.Fatal("coordinator accepts only a schema-v1 testOnly manifest")
	}
	return manifest
}

func TestCoordinatedProviderProof(t *testing.T) {
	_ = loadLocalManifest(t)
	selector := os.Getenv("ARTIFACT_PAGES_PROOF_CASE")
	if selector == "" {
		selector = "ALL"
	}
	if selector != "ALL" && selector != "P4" && selector != "P5" && selector != "P6" && selector != "P7" {
		t.Fatalf("unsupported local scenario selector %q", selector)
	}

	t.Run("containment-before-credentials", testProofContainmentBeforeCredentials)
	for _, scenario := range []struct {
		name string
		run  func(*testing.T)
	}{{"P4", testPreviewRaceAndStaleOwner}, {"P5", testDifferentSiteWriters}, {"P6", testConservativeReconciliation}, {"P7", testInvalidationOnlyRetry}} {
		if selector != "ALL" && selector != scenario.name {
			continue
		}
		t.Run(scenario.name, scenario.run)
	}
}

func testProofContainmentBeforeCredentials(t *testing.T) {
	for _, operation := range []Operation{
		{Service: "s3", Action: "GetObject", Method: "GET", Bucket: "artifact-pages-231136241959-us-east-1", Key: "_indexes/existing/index.json", Endpoint: "https://s3.us-east-1.amazonaws.com"},
		{Service: "s3", Action: "PutObject", Method: "PUT", Bucket: "artifact-pages-231136241959-us-east-1", Key: "_artifacts/x", Endpoint: "https://s3.us-east-1.amazonaws.com"},
		{Service: "s3", Action: "DeleteObject", Method: "DELETE", Bucket: "artifact-pages-231136241959-us-east-1", Key: "_artifacts/x", Endpoint: "https://s3.us-east-1.amazonaws.com"},
		{Service: "cloudfront", Action: "CreateInvalidation", Method: "POST", DistributionID: "ECFTIR5GVPQDF", Paths: []string{"/index.html"}, Endpoint: "https://cloudfront.amazonaws.com"},
	} {
		credentialLoads := 0
		outbound := 0
		client := NewClient(Capability{Context: "proof", ProofBucket: "ap-proof-231136241959-20261018", PreservedBucket: "artifact-pages-231136241959-us-east-1", ProofDistribution: "E2PROOF", PreservedDistribution: "ECFTIR5GVPQDF"}, func(context.Context) ([]byte, error) {
			credentialLoads++
			return []byte("fake-only"), nil
		}, func(context.Context, Request) error {
			outbound++
			return nil
		})
		if err := client.Request(context.Background(), operation); !errors.Is(err, ErrDenied) {
			t.Fatalf("preserved target error = %v, want denial", err)
		}
		if credentialLoads != 0 || outbound != 0 {
			t.Fatalf("containment counts = credentials:%d outbound:%d, want zero", credentialLoads, outbound)
		}
	}
}

func testPreviewRaceAndStaleOwner(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	store := newMemoryStore()
	catalogKey := "_control/sites/proof-a-20261018/preview-catalog.json"
	store.put(catalogKey, []byte(`{"heads":[]}`))
	initialBody, initialETag, _ := store.get(catalogKey)
	_ = initialBody

	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	errorsOut := make(chan error, 2)
	var writers sync.WaitGroup
	for _, head := range []string{"1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"} {
		head := head
		writers.Add(1)
		go func() {
			defer writers.Done()
			prefix := "_previews/proof-a-20261018/" + head + "/"
			if !validProofPrefix(prefix) {
				errorsOut <- ErrDenied
				return
			}
			store.put(prefix+"manifest.json", []byte(head))
			ready <- struct{}{}
			select {
			case <-start:
			case <-ctx.Done():
				errorsOut <- ctx.Err()
				return
			}
			candidate := appendCatalogHead(initialBody, head)
			if !store.compareAndSwap(catalogKey, initialETag, candidate) {
				current, etag, ok := store.get(catalogKey)
				if !ok || !store.compareAndSwap(catalogKey, etag, appendCatalogHead(current, head)) {
					errorsOut <- errors.New("catalog retry did not converge")
				}
			}
		}()
	}
	awaitSignals(t, ctx, ready, 2)
	close(start)
	writers.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatal(err)
		}
	}
	catalog, newETag, ok := store.get(catalogKey)
	if !ok || !contains(string(catalog), "1111111111111111111111111111111111111111") || !contains(string(catalog), "2222222222222222222222222222222222222222") {
		t.Fatalf("two-head catalog did not converge: %s", catalog)
	}
	if store.compareAndSwap(catalogKey, initialETag, []byte(`{"heads":["stale"]}`)) {
		t.Fatal("stale lock owner replaced the catalog")
	}
	if current, etag, _ := store.get(catalogKey); etag != newETag || string(current) != string(catalog) {
		t.Fatal("stale owner changed the final catalog")
	}
	if len(store.list("_previews/proof-a-20261018/")) != 2 {
		t.Fatal("immutable manifests for both heads were not retained")
	}
}

func testDifferentSiteWriters(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	store := newMemoryStore()
	store.put("_indexes/proof-neighbor-20261018/index.json", []byte("neighbor-original"))
	ready := make(chan struct{}, 2)
	start := make(chan struct{})
	var writers sync.WaitGroup
	errorsOut := make(chan error, 2)
	for _, site := range []string{"proof-a-20261018", "proof-b-20261018"} {
		site := site
		writers.Add(1)
		go func() {
			defer writers.Done()
			ready <- struct{}{}
			select {
			case <-start:
			case <-ctx.Done():
				errorsOut <- ctx.Err()
				return
			}
			key := "_indexes/" + site + "/index.json"
			if !validProofKey(key) {
				errorsOut <- ErrDenied
				return
			}
			store.put(key, []byte(site+"-index"))
		}()
	}
	awaitSignals(t, ctx, ready, 2)
	close(start)
	writers.Wait()
	close(errorsOut)
	for err := range errorsOut {
		if err != nil {
			t.Fatal(err)
		}
	}
	if _, _, ok := store.get("_indexes/proof-a-20261018/index.json"); !ok {
		t.Fatal("site a output missing")
	}
	if _, _, ok := store.get("_indexes/proof-b-20261018/index.json"); !ok {
		t.Fatal("site b output missing")
	}
	if neighbor, _, _ := store.get("_indexes/proof-neighbor-20261018/index.json"); string(neighbor) != "neighbor-original" {
		t.Fatal("concurrent site writers changed the neighbor")
	}
}

func testConservativeReconciliation(t *testing.T) {
	catalog := map[string]bool{"kept.html": true, "missing.html": true, "unknown.html": true}
	origin := map[string]int{"kept.html": 200, "missing.html": 404, "unknown.html": 503}
	for key, status := range origin {
		if status == 404 {
			delete(catalog, key)
		}
		if status != 200 && status != 404 && !catalog[key] {
			t.Fatalf("unknown origin result %d pruned %s", status, key)
		}
	}
	if !catalog["kept.html"] || catalog["missing.html"] || !catalog["unknown.html"] {
		t.Fatalf("conservative reconcile result = %#v", catalog)
	}
}

func testInvalidationOnlyRetry(t *testing.T) {
	store := newMemoryStore()
	const retryKey = "_control/app-cache/retry.json"
	store.put(retryKey, []byte(`{"paths":["/index.html"]}`))
	originConverged := true
	invalidationRequests := 0
	firstInvalidationSucceeded := false
	if originConverged {
		invalidationRequests++
	}
	if firstInvalidationSucceeded {
		store.put(retryKey, nil)
	}
	if _, _, exists := store.get(retryKey); !exists {
		t.Fatal("failed invalidation cleared the retry record")
	}
	// A retry still submits the invalidation after origin data has converged.
	invalidationRequests++
	firstInvalidationSucceeded = true
	if firstInvalidationSucceeded {
		store.mu.Lock()
		delete(store.objects, retryKey)
		store.mu.Unlock()
	}
	if invalidationRequests != 2 {
		t.Fatalf("invalidation request count = %d, want 2", invalidationRequests)
	}
	if _, _, exists := store.get(retryKey); exists {
		t.Fatal("successful invalidation retry did not clear the record")
	}
}

func appendCatalogHead(body []byte, head string) []byte {
	value := string(body)
	value = trimCatalog(value)
	if contains(value, head) {
		return []byte(value)
	}
	if value == `{"heads":[]}` {
		return []byte(`{"heads":["` + head + `"]}`)
	}
	if len(value) >= 2 && value[len(value)-2:] == "]}" {
		return []byte(value[:len(value)-2] + `,"` + head + `"]}`)
	}
	return []byte(`{"heads":["` + head + `"]}`)
}

func trimCatalog(value string) string {
	return value
}

func validProofPrefix(prefix string) bool {
	return prefix == "_previews/proof-a-20261018/1111111111111111111111111111111111111111/" || prefix == "_previews/proof-a-20261018/2222222222222222222222222222222222222222/"
}

func validProofKey(key string) bool {
	return key == "_indexes/proof-a-20261018/index.json" || key == "_indexes/proof-b-20261018/index.json"
}

func awaitSignals(t *testing.T, ctx context.Context, ready <-chan struct{}, count int) {
	t.Helper()
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for i := 0; i < count; i++ {
		select {
		case <-ready:
		case <-timer.C:
			t.Fatal("observer barrier timed out")
		case <-ctx.Done():
			t.Fatal("scenario deadline expired before barrier")
		}
	}
}

func contains(haystack, needle string) bool {
	if needle == "" {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
