package publisher

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
)

// TestAWSPreviewPublicationFlowSmoke is an opt-in real-provider smoke for the
// shared PreviewStore publication flow. All preview records, including the
// temporary catalog and lock, are remapped below one random unadvertised
// namespace under the selected disposable registered site's _previews prefix.
// This test does not modify the site's real catalog or its production lock.
func TestAWSPreviewPublicationFlowSmoke(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_RUN") != "1" {
		t.Skip("set ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_RUN=1 to run the isolated AWS preview publication smoke")
	}
	region := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_REGION"))
	bucket := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_BUCKET"))
	site := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE"))
	if region == "" || bucket == "" || site == "" {
		t.Fatal("ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_REGION, _DISPOSABLE_BUCKET, and _DISPOSABLE_SITE are required")
	}
	if err := registry.ValidateSiteID(site); err != nil {
		t.Fatalf("invalid ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE: %v", err)
	}
	confirmation := fmt.Sprintf("WRITE AND DELETE RANDOM PREVIEW DATA AND ALL VERSIONS/DELETE MARKERS IN DISPOSABLE S3 BUCKET %s FOR REGISTERED SMOKE SITE %s", bucket, site)
	if os.Getenv("ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_CONFIRM") != confirmation {
		t.Fatalf("set ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_CONFIRM=%q to authorize the isolated disposable-site preview smoke", confirmation)
	}

	backend, err := NewAWSBackend(t.Context(), AWSOptions{Region: region, Bucket: bucket})
	if err != nil {
		t.Fatalf("create AWS backend: %v", err)
	}
	runPreviewPublicationFlowSmoke(t, backend, site, "S3")
}

// TestCloudflarePreviewPublicationFlowSmoke is the R2 counterpart of the AWS
// preview-flow smoke. It shares the same isolated ObjectPreviewStore exercise.
func TestCloudflarePreviewPublicationFlowSmoke(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_RUN") != "1" {
		t.Skip("set ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_RUN=1 to run the isolated Cloudflare R2 preview publication smoke")
	}
	accountID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_ACCOUNT_ID"))
	bucket := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_DISPOSABLE_BUCKET"))
	zoneID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_ZONE_ID"))
	publicBaseURL := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_PUBLIC_BASE_URL"))
	site := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE"))
	accessKeyID := strings.TrimSpace(os.Getenv("CF_R2_ACCESS_KEY_ID"))
	secretAccessKey := strings.TrimSpace(os.Getenv("CF_R2_SECRET_ACCESS_KEY"))
	sessionToken := strings.TrimSpace(os.Getenv("CF_R2_SESSION_TOKEN"))
	if accountID == "" || bucket == "" || zoneID == "" || publicBaseURL == "" || site == "" || accessKeyID == "" || secretAccessKey == "" {
		t.Fatal("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_ACCOUNT_ID, _DISPOSABLE_BUCKET, _ZONE_ID, _PUBLIC_BASE_URL, _DISPOSABLE_SITE, CF_R2_ACCESS_KEY_ID, and CF_R2_SECRET_ACCESS_KEY are required")
	}
	if err := registry.ValidateSiteID(site); err != nil {
		t.Fatalf("invalid ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE: %v", err)
	}
	confirmation := fmt.Sprintf("WRITE AND DELETE RANDOM PREVIEW DATA IN DISPOSABLE R2 BUCKET %s FOR REGISTERED SMOKE SITE %s", bucket, site)
	if os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_CONFIRM") != confirmation {
		t.Fatalf("set ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_CONFIRM=%q to authorize the isolated disposable-site preview smoke", confirmation)
	}

	backend, err := NewCloudflareBackend(t.Context(), CloudflareOptions{
		AccountID: accountID, Bucket: bucket, ZoneID: zoneID, PublicBaseURL: publicBaseURL,
		AccessKeyID: accessKeyID, SecretKey: secretAccessKey, SessionToken: sessionToken,
	})
	if err != nil {
		t.Fatalf("create Cloudflare R2 backend: %v", err)
	}
	runPreviewPublicationFlowSmoke(t, backend, site, "R2")
}

// The live smoke does not claim interruption retry or forced lock loss.
// Synthetic failures here would exercise client-side test hooks rather than
// provider behavior; deterministic AWS/R2 fake integrations cover those paths.
func runPreviewPublicationFlowSmoke(t *testing.T, backend DeploymentBackend, site, provider string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Minute)
	defer cancel()
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		t.Fatalf("%s backend %T does not implement conditional object operations", provider, backend)
	}
	projection, err := loadOriginRegistry(ctx, conditional)
	if err != nil {
		t.Fatalf("read registered sites from %s origin: %v", provider, err)
	}
	if _, found := registrySite(projection, site); !found {
		t.Fatalf("preview-flow smoke site %q is not present in the deployed registry", site)
	}

	var randomID [16]byte
	if _, err := rand.Read(randomID[:]); err != nil {
		t.Fatalf("generate isolated preview namespace: %v", err)
	}
	namespace := fmt.Sprintf("_previews/%s/.artifact-pages-preview-flow-smoke-%s/", site, hex.EncodeToString(randomID[:]))
	var awsVersionClient awsLiveSmokeVersionAPI
	versionSpec := awsPreviewFlowSmokePrefixSpec
	versionSpec.site = site
	if provider == "S3" {
		awsTarget, ok := backend.(*awsBackend)
		if !ok {
			t.Fatalf("AWS preview smoke backend has unexpected type %T", backend)
		}
		awsVersionClient, ok = awsTarget.s3CompatibleBackend.client.(awsLiveSmokeVersionAPI)
		if !ok {
			t.Fatalf("AWS preview smoke client %T does not support version-aware smoke cleanup", awsTarget.s3CompatibleBackend.client)
		}
		versions, err := listAWSLiveSmokeVersions(ctx, awsVersionClient, awsTarget.s3CompatibleBackend.bucket, namespace, versionSpec)
		if err != nil {
			t.Fatalf("check isolated AWS preview namespace versions: %v", err)
		}
		if len(versions) != 0 {
			t.Fatalf("random AWS preview namespace is unexpectedly occupied by versions or delete markers: %v", describeAWSLiveSmokeResiduals(versions))
		}
	} else if keys, err := backend.ListKeys(ctx, namespace); err != nil {
		t.Fatalf("check isolated %s preview namespace: %v", provider, err)
	} else if len(keys) != 0 {
		t.Fatalf("random %s preview namespace is unexpectedly occupied: %q", provider, keys)
	}

	// Keep all writes, including the mutable catalog and cooperative lock,
	// beneath this unique prefix. The real registered-site catalog and lock are
	// read-only inputs to the smoke.
	isolatedBackend := &previewFlowSmokeBackend{
		ConditionalObjectBackend: conditional,
		site:                     site,
		namespace:                namespace,
		conditionalPuts:          make(map[string]int),
		ordinaryPuts:             make(map[string]int),
	}
	assertPreviewFlowSmokeRemapperRejectsEscapes(t, ctx, isolatedBackend)
	store, err := NewObjectPreviewStore(isolatedBackend)
	if err != nil {
		t.Fatalf("create isolated %s preview store: %v", provider, err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 45*time.Second)
		defer cleanupCancel()
		if provider == "S3" {
			awsTarget, ok := backend.(*awsBackend)
			if !ok {
				t.Errorf("AWS preview smoke backend has unexpected type %T", backend)
				return
			}
			if err := cleanupAWSLiveSmokePrefix(cleanupCtx, awsVersionClient, awsTarget.s3CompatibleBackend.bucket, namespace, versionSpec); err != nil {
				t.Errorf("clean all versions and delete markers from isolated AWS preview namespace: %v", err)
			}
			return
		}
		keys, listErr := backend.ListKeys(cleanupCtx, namespace)
		if listErr != nil {
			t.Errorf("list only the isolated %s preview namespace for cleanup: %v", provider, listErr)
			return
		}
		for _, key := range keys {
			if !strings.HasPrefix(key, namespace) {
				t.Errorf("refusing to delete %s smoke key outside its random namespace: %q", provider, key)
				return
			}
		}
		if len(keys) != 0 {
			if deleteErr := backend.DeleteObjects(cleanupCtx, keys); deleteErr != nil {
				t.Errorf("delete isolated %s preview namespace: %v", provider, deleteErr)
				return
			}
		}
		remaining, listErr := backend.ListKeys(cleanupCtx, namespace)
		if listErr != nil || len(remaining) != 0 {
			t.Errorf("isolated %s preview namespace remains after cleanup: keys=%q err=%v", provider, remaining, listErr)
		}
	})

	catalogKey, err := preview.CatalogKey(site)
	if err != nil {
		t.Fatalf("build preview catalog key: %v", err)
	}
	emptyCatalog, err := preview.EncodeCatalog(preview.Catalog{SchemaVersion: preview.SchemaVersion, Site: site, Groups: []preview.Group{}, RevisionHistory: []preview.GroupRevisionHistory{}})
	if err != nil {
		t.Fatalf("encode empty catalog guard fixture: %v", err)
	}
	if err := store.ReplaceMutableObject(ctx, catalogKey, emptyCatalog); err == nil || !strings.Contains(err.Error(), "requires an active site lock") {
		t.Fatalf("catalog replacement without a lock returned %v; want rejection before provider write", err)
	}
	if keys, err := backend.ListKeys(ctx, namespace); err != nil || len(keys) != 0 {
		t.Fatalf("unlocked catalog attempt wrote into isolated namespace: keys=%q err=%v", keys, err)
	}

	first := makePreviewFlowSmokeResult(t, site, hex.EncodeToString(randomID[:]), "first")
	second := makePreviewFlowSmokeResult(t, site, hex.EncodeToString(randomID[:]), "second")
	if err := preview.Publish(ctx, store, first); err != nil {
		t.Fatalf("publish first isolated %s preview group: %v", provider, err)
	}
	assertPreviewFlowSmokeCatalog(t, ctx, store, catalogKey, first.Group.ID)
	if isolatedBackend.heldCatalogPuts() != 1 {
		t.Fatalf("first %s catalog write observed %d held-lock writes; want 1", provider, isolatedBackend.heldCatalogPuts())
	}

	firstFilePath := first.Manifest.Files[0].Path
	firstFileKey, err := preview.FileKey(site, first.Manifest.HeadSHA, firstFilePath)
	if err != nil {
		t.Fatalf("build first smoke file key: %v", err)
	}
	firstManifestKey, err := preview.ManifestKey(site, first.Manifest.HeadSHA)
	if err != nil {
		t.Fatalf("build first smoke manifest key: %v", err)
	}
	immutableKeys := []string{firstFileKey, firstManifestKey}
	immutableBytes := [][]byte{first.Files[firstFilePath], mustEncodeSmokeManifest(t, first.Manifest)}
	for index, key := range immutableKeys {
		mapped := mustMapPreviewFlowSmokeKey(t, isolatedBackend, key)
		before, beforeETag, getErr := conditional.GetObject(ctx, mapped)
		if getErr != nil || !equalBytes(before.Bytes, immutableBytes[index]) || beforeETag == "" {
			t.Fatalf("read first %s immutable object %q: ETag=%q err=%v", provider, mapped, beforeETag, getErr)
		}
		if err := store.CreateImmutableObject(ctx, key, immutableBytes[index]); err != nil {
			t.Fatalf("same-byte create-once retry for %s object %q: %v", provider, key, err)
		}
		if err := store.CreateImmutableObject(ctx, key, []byte("different immutable bytes")); !errors.Is(err, preview.ErrImmutableObjectConflict) {
			t.Fatalf("changed-byte create-once attempt for %s object %q returned %v; want immutable conflict", provider, key, err)
		}
		after, afterETag, getErr := conditional.GetObject(ctx, mapped)
		if getErr != nil || afterETag != beforeETag || !equalBytes(after.Bytes, immutableBytes[index]) {
			t.Fatalf("%s immutable object %q changed after create-once retries: ETag %q -> %q, err=%v", provider, mapped, beforeETag, afterETag, getErr)
		}
	}

	// A repeated publication of the same head must retain its stored bytes and
	// must not rewrite the existing catalog or refresh object lifecycle age.
	firstCatalogKey := mustMapPreviewFlowSmokeKey(t, isolatedBackend, catalogKey)
	firstCatalog, firstCatalogETag, err := conditional.GetObject(ctx, firstCatalogKey)
	if err != nil || (firstCatalogETag == "" && provider != "memory fake") {
		t.Fatalf("read first %s catalog: ETag=%q err=%v", provider, firstCatalogETag, err)
	}
	putsBeforeRetry := isolatedBackend.putCounts()
	if err := preview.Publish(ctx, store, first); err != nil {
		t.Fatalf("same-head %s preview retry: %v", provider, err)
	}
	putsAfterRetry := isolatedBackend.putCounts()
	if !samePreviewFlowSmokeCounts(putsBeforeRetry, putsAfterRetry) {
		t.Fatalf("same-head %s retry issued provider writes: before=%v after=%v", provider, putsBeforeRetry, putsAfterRetry)
	}
	catalogAfterRetry, catalogETagAfterRetry, err := conditional.GetObject(ctx, firstCatalogKey)
	if err != nil || (firstCatalogETag != "" && catalogETagAfterRetry != firstCatalogETag) || !equalBytes(catalogAfterRetry.Bytes, firstCatalog.Bytes) {
		t.Fatalf("same-head %s retry changed catalog: ETag %q -> %q err=%v", provider, firstCatalogETag, catalogETagAfterRetry, err)
	}

	if err := preview.Publish(ctx, store, second); err != nil {
		t.Fatalf("publish second isolated %s preview group: %v", provider, err)
	}
	assertPreviewFlowSmokeCatalog(t, ctx, store, catalogKey, first.Group.ID, second.Group.ID)
	if isolatedBackend.heldCatalogPuts() != 2 {
		t.Fatalf("two %s catalog updates observed %d held-lock writes; want 2", provider, isolatedBackend.heldCatalogPuts())
	}
	lock, err := (SiteLockManager{Backend: isolatedBackend}).Inspect(ctx, site)
	if err != nil || lock.State != "free" {
		t.Fatalf("%s isolated site lock after publications = %+v err=%v; want a retained free record", provider, lock, err)
	}
}

func TestPreviewPublicationFlowSmokeUsesAndRemovesOnlyItsNamespace(t *testing.T) {
	backend := newLockMemoryBackend()
	projection, _, err := testRegistryBuild(t, []byte(registeredSREAndDocsManifest))
	if err != nil {
		t.Fatalf("build registered-site fixture: %v", err)
	}
	if err := backend.PutObject(context.Background(), "_indexes/sites.json", Object{Bytes: projection}); err != nil {
		t.Fatalf("seed registered-site projection: %v", err)
	}
	t.Cleanup(func() {
		keys, err := backend.ListKeys(context.Background(), "_previews/sre/")
		if err != nil || len(keys) != 0 {
			t.Errorf("preview-flow helper left objects outside its test lifetime: keys=%q err=%v", keys, err)
		}
	})
	runPreviewPublicationFlowSmoke(t, backend, "sre", "memory fake")
}

// previewFlowSmokeBackend remaps canonical preview keys and the per-site lock
// to one isolated random prefix. It instruments catalog puts to prove the
// provider currently contains a held lock record when each mutable catalog
// write is sent.
type previewFlowSmokeBackend struct {
	ConditionalObjectBackend
	site              string
	namespace         string
	mu                sync.Mutex
	conditionalPuts   map[string]int
	ordinaryPuts      map[string]int
	heldCatalogWrites int
}

func (backend *previewFlowSmokeBackend) mapKey(key string) (string, error) {
	key = strings.TrimPrefix(key, "/")
	if key == siteLockKey(backend.site) {
		return backend.namespace + "control/locks/site.json", nil
	}
	if key == legacySiteLockKey(backend.site) {
		return backend.namespace + "control/locks/legacy-site.json", nil
	}
	canonicalPrefix := "_previews/" + backend.site + "/"
	if strings.HasPrefix(key, canonicalPrefix) {
		return backend.namespace + "projection/" + strings.TrimPrefix(key, canonicalPrefix), nil
	}
	return "", fmt.Errorf("isolated preview smoke refuses provider access outside site %q preview keys and its lock: %q", backend.site, key)
}

func (backend *previewFlowSmokeBackend) PutObject(ctx context.Context, key string, object Object) error {
	mapped, err := backend.mapKey(key)
	if err != nil {
		return err
	}
	if strings.TrimPrefix(key, "/") == "_previews/"+backend.site+"/catalog.json" {
		mappedLockKey, mapErr := backend.mapKey(siteLockKey(backend.site))
		if mapErr != nil {
			return mapErr
		}
		lockObject, _, err := backend.ConditionalObjectBackend.GetObject(ctx, mappedLockKey)
		if err != nil {
			return fmt.Errorf("read isolated lock before catalog write: %w", err)
		}
		record, err := decodeLockRecord(lockObject.Bytes, backend.site)
		if err != nil || record.State != "held" {
			return fmt.Errorf("refuse isolated catalog write without a held provider lock: record=%+v err=%v", record, err)
		}
		backend.mu.Lock()
		backend.heldCatalogWrites++
		backend.mu.Unlock()
	}
	backend.mu.Lock()
	backend.ordinaryPuts[mapped]++
	backend.mu.Unlock()
	return backend.ConditionalObjectBackend.PutObject(ctx, mapped, object)
}

func (backend *previewFlowSmokeBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	mappedPrefix, err := backend.mapPrefix(prefix)
	if err != nil {
		return nil, err
	}
	keys, err := backend.ConditionalObjectBackend.ListKeys(ctx, mappedPrefix)
	if err != nil {
		return nil, err
	}
	for index := range keys {
		if !strings.HasPrefix(keys[index], mappedPrefix) || !strings.HasPrefix(keys[index], backend.namespace) {
			return nil, fmt.Errorf("isolated preview smoke listing returned key outside its random prefix %q: %q", mappedPrefix, keys[index])
		}
		keys[index] = backend.unmapKey(keys[index])
	}
	return keys, nil
}

func (backend *previewFlowSmokeBackend) DeleteObjects(ctx context.Context, keys []string) error {
	mapped := make([]string, len(keys))
	for index, key := range keys {
		var err error
		mapped[index], err = backend.mapKey(key)
		if err != nil {
			return err
		}
	}
	return backend.ConditionalObjectBackend.DeleteObjects(ctx, mapped)
}

func (backend *previewFlowSmokeBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	mapped, err := backend.mapKey(key)
	if err != nil {
		return Object{}, "", err
	}
	return backend.ConditionalObjectBackend.GetObject(ctx, mapped)
}

func (backend *previewFlowSmokeBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	mapped, err := backend.mapKey(key)
	if err != nil {
		return ObjectInfo{}, err
	}
	return backend.ConditionalObjectBackend.HeadObject(ctx, mapped)
}

func (backend *previewFlowSmokeBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	mapped, err := backend.mapKey(key)
	if err != nil {
		return "", err
	}
	backend.mu.Lock()
	backend.conditionalPuts[mapped]++
	backend.mu.Unlock()
	return backend.ConditionalObjectBackend.PutObjectConditional(ctx, mapped, object, condition)
}

func (backend *previewFlowSmokeBackend) mapPrefix(prefix string) (string, error) {
	prefix = strings.TrimPrefix(prefix, "/")
	canonicalPrefix := "_previews/" + backend.site + "/"
	if strings.HasPrefix(prefix, canonicalPrefix) {
		return backend.namespace + "projection/" + strings.TrimPrefix(prefix, canonicalPrefix), nil
	}
	if prefix == siteLockKey(backend.site) {
		return backend.mapKey(prefix)
	}
	return "", fmt.Errorf("isolated preview smoke refuses provider listing outside site %q preview keys: %q", backend.site, prefix)
}

func (backend *previewFlowSmokeBackend) unmapKey(key string) string {
	projectionPrefix := backend.namespace + "projection/"
	if strings.HasPrefix(key, projectionPrefix) {
		return "_previews/" + backend.site + "/" + strings.TrimPrefix(key, projectionPrefix)
	}
	lockKey := backend.namespace + "control/locks/site.json"
	if key == lockKey {
		return siteLockKey(backend.site)
	}
	return key
}

func (backend *previewFlowSmokeBackend) Invalidate(context.Context, []string) (string, error) {
	return "", errors.New("isolated preview smoke refuses provider cache invalidation")
}

func mustMapPreviewFlowSmokeKey(t *testing.T, backend *previewFlowSmokeBackend, key string) string {
	t.Helper()
	mapped, err := backend.mapKey(key)
	if err != nil {
		t.Fatalf("map isolated preview key %q: %v", key, err)
	}
	return mapped
}

func assertPreviewFlowSmokeRemapperRejectsEscapes(t *testing.T, ctx context.Context, backend *previewFlowSmokeBackend) {
	t.Helper()
	assertRejected := func(operation string, err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "isolated preview smoke refuses") {
			t.Fatalf("isolated backend %s returned %v; want a pre-provider namespace rejection", operation, err)
		}
	}
	if _, _, err := backend.GetObject(ctx, "_indexes/sites.json"); err == nil || !strings.Contains(err.Error(), "isolated preview smoke refuses") {
		t.Fatalf("isolated backend registry read error = %v; want a pre-provider namespace rejection", err)
	}
	if _, _, err := backend.GetObject(ctx, siteLockKey("docs")); err == nil || !strings.Contains(err.Error(), "isolated preview smoke refuses") {
		t.Fatalf("isolated backend other-site lock read error = %v; want a pre-provider namespace rejection", err)
	}
	assertRejected("PutObject outside the preview namespace", backend.PutObject(ctx, "_indexes/sites.json", Object{Bytes: []byte("must not write")}))
	_, err := backend.ListKeys(ctx, "_control/")
	assertRejected("ListKeys outside the preview namespace", err)
	assertRejected("DeleteObjects outside the preview namespace", backend.DeleteObjects(ctx, []string{"_indexes/sites.json"}))
	_, err = backend.Invalidate(ctx, []string{"/*"})
	if err == nil || !strings.Contains(err.Error(), "refuses provider cache invalidation") {
		t.Fatalf("isolated backend Invalidate() error = %v; want rejection", err)
	}
}

func (backend *previewFlowSmokeBackend) heldCatalogPuts() int {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.heldCatalogWrites
}

func (backend *previewFlowSmokeBackend) putCounts() map[string][2]int {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	counts := make(map[string][2]int, len(backend.ordinaryPuts)+len(backend.conditionalPuts))
	for key, count := range backend.ordinaryPuts {
		counts[key] = [2]int{count, counts[key][1]}
	}
	for key, count := range backend.conditionalPuts {
		counts[key] = [2]int{counts[key][0], count}
	}
	return counts
}

func samePreviewFlowSmokeCounts(left, right map[string][2]int) bool {
	for key, count := range left {
		if strings.Contains(key, "/control/locks/") {
			continue
		}
		if right[key] != count {
			return false
		}
	}
	for key, count := range right {
		if strings.Contains(key, "/control/locks/") {
			continue
		}
		if left[key] != count {
			return false
		}
	}
	return true
}

func makePreviewFlowSmokeResult(t *testing.T, site, token, label string) preview.BuildResult {
	t.Helper()
	var identity [20]byte
	if _, err := rand.Read(identity[:]); err != nil {
		t.Fatalf("generate isolated preview head: %v", err)
	}
	head := hex.EncodeToString(identity[:])
	if _, err := rand.Read(identity[:]); err != nil {
		t.Fatalf("generate isolated preview default head: %v", err)
	}
	defaultHead := hex.EncodeToString(identity[:])
	filePath := "smoke-" + token + "/" + label + ".html"
	fileBytes := []byte(fmt.Sprintf("<!doctype html><title>Artifact Pages %s smoke</title><h1>%s preview smoke</h1>\n", label, label))
	fileSHA := sha256.Sum256(fileBytes)
	now := time.Now().UTC().Format(time.RFC3339Nano)
	document := preview.Document{Path: filePath, Title: "Artifact Pages live preview smoke", Format: "html"}
	files := map[string][]byte{filePath: fileBytes}
	manifest := preview.RevisionManifest{
		SchemaVersion: preview.SchemaVersion,
		Site:          site,
		HeadSHA:       head,
		DefaultHead:   defaultHead,
		MergeBase:     defaultHead,
		CreatedAt:     now,
		BundleDigest:  previewSmokeBundleDigest(files),
		Files: []preview.PreviewFile{{
			Path: filePath, SHA256: hex.EncodeToString(fileSHA[:]), ContentType: "text/html; charset=utf-8",
		}},
		Documents: []preview.Document{document},
	}
	group := preview.Group{
		ID: "head:" + head, Kind: "manual", HeadSHA: head, UpdatedAt: now,
		Documents: []preview.Document{document},
	}
	return preview.BuildResult{Site: site, Outcome: preview.OutcomePublished, Group: group, Manifest: manifest, Files: files}
}

func previewSmokeBundleDigest(files map[string][]byte) string {
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	// A smoke bundle contains one object, but sorting keeps the digest helper
	// faithful to the provider-neutral bundle contract if it is extended later.
	sort.Strings(paths)
	hasher := sha256.New()
	for _, path := range paths {
		var length [8]byte
		binary.BigEndian.PutUint64(length[:], uint64(len(path)))
		_, _ = hasher.Write(length[:])
		_, _ = hasher.Write([]byte(path))
		binary.BigEndian.PutUint64(length[:], uint64(len(files[path])))
		_, _ = hasher.Write(length[:])
		_, _ = hasher.Write(files[path])
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

func assertPreviewFlowSmokeCatalog(t *testing.T, ctx context.Context, store *ObjectPreviewStore, catalogKey string, expectedGroupIDs ...string) {
	t.Helper()
	contents, err := store.ReadObject(ctx, catalogKey)
	if err != nil {
		t.Fatalf("read isolated preview smoke catalog: %v", err)
	}
	catalog, err := preview.DecodeCatalog(contents)
	if err != nil {
		t.Fatalf("decode isolated preview smoke catalog: %v", err)
	}
	got := make(map[string]bool, len(catalog.Groups))
	for _, group := range catalog.Groups {
		got[group.ID] = true
	}
	if len(got) != len(expectedGroupIDs) {
		t.Fatalf("isolated preview catalog groups = %v; want exactly %v", got, expectedGroupIDs)
	}
	for _, id := range expectedGroupIDs {
		if !got[id] {
			t.Fatalf("isolated preview catalog is missing group %q: got %v", id, got)
		}
	}
}

func mustEncodeSmokeManifest(t *testing.T, manifest preview.RevisionManifest) []byte {
	t.Helper()
	contents, err := preview.EncodeManifest(manifest)
	if err != nil {
		t.Fatalf("encode expected preview smoke manifest: %v", err)
	}
	return contents
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
