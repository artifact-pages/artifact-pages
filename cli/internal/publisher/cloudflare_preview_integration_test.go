package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
)

func TestCloudflarePreviewIntegrationRetriesInterruptedWriteIdempotentlyAndIsolatesSites(t *testing.T) {
	backend, endpoint := newCloudflarePreviewIntegrationBackend(t)
	seedCloudflarePreviewRegistry(t, endpoint)
	seedCloudflarePreviewNeighbor(t, endpoint)
	neighborBefore := endpoint.snapshotPrefix("_previews/docs/")
	docsLockBefore, docsLockETagBefore, exists := endpoint.snapshot(siteLockKey("docs"))
	if !exists {
		t.Fatal("neighboring docs lock was not seeded")
	}

	root := createPreviewPublisherCheckout(t)
	options := cloudflarePreviewBuildOptions(t, root, "preview", 42)
	expected, err := preview.BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit() = %v", err)
	}
	manifestKey, err := preview.ManifestKey(expected.Site, expected.Manifest.HeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.failNextPut(providerObjectKey(manifestKey))

	first, err := BuildAndPublishPreview(context.Background(), backend, options)
	if err == nil || !strings.Contains(err.Error(), "write preview manifest") {
		t.Fatalf("first Cloudflare BuildAndPublishPreview() = %+v, %v; want interrupted manifest write", first, err)
	}
	if first.Manifest.HeadSHA != expected.Manifest.HeadSHA {
		t.Fatalf("failed publication HEAD = %q, want %q", first.Manifest.HeadSHA, expected.Manifest.HeadSHA)
	}
	if _, _, exists := endpoint.snapshot(providerObjectKey(manifestKey)); exists {
		t.Fatal("manifest exists after the injected interrupted R2 write")
	}
	catalogKey, err := preview.CatalogKey(expected.Site)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, exists := endpoint.snapshot(providerObjectKey(catalogKey)); exists {
		t.Fatal("preview catalog was written before the interrupted R2 manifest write completed")
	}
	for filePath, contents := range expected.Files {
		fileKey, keyErr := preview.FileKey(expected.Site, expected.Manifest.HeadSHA, filePath)
		if keyErr != nil {
			t.Fatal(keyErr)
		}
		object, _, exists := endpoint.snapshot(providerObjectKey(fileKey))
		if !exists || !bytes.Equal(object.Bytes, contents) {
			t.Fatalf("completed R2 file %q = %q (exists=%t), want %q after interruption", fileKey, object.Bytes, exists, contents)
		}
	}

	second, err := BuildAndPublishPreview(context.Background(), backend, options)
	if err != nil || second.Outcome != preview.OutcomePublished || second.Manifest.HeadSHA != expected.Manifest.HeadSHA {
		t.Fatalf("retry Cloudflare BuildAndPublishPreview() = %+v, %v; want successful retry of same head", second, err)
	}
	catalogObject, _, exists := endpoint.snapshot(providerObjectKey(catalogKey))
	if !exists {
		t.Fatal("preview catalog is missing after successful retry")
	}
	catalog, err := preview.DecodeCatalog(catalogObject.Bytes)
	if err != nil || len(catalog.Groups) != 1 || catalog.Groups[0].ID != "pr:42" {
		t.Fatalf("catalog after retry = %+v, decode error = %v; want only pr:42", catalog, err)
	}
	objectsAfterRetry := endpoint.snapshotPrefix("_previews/sre/")
	putsAfterRetry := endpoint.putsForPreviewPrefix("_previews/sre/")
	repeated, err := BuildAndPublishPreview(context.Background(), backend, options)
	if err != nil || repeated.Manifest.HeadSHA != expected.Manifest.HeadSHA {
		t.Fatalf("idempotent retry Cloudflare BuildAndPublishPreview() = %+v, %v", repeated, err)
	}
	if after := endpoint.snapshotPrefix("_previews/sre/"); !cloudflarePreviewObjectsEqual(objectsAfterRetry, after) {
		t.Errorf("idempotent retry changed immutable/catalog objects: before=%v after=%v", cloudflarePreviewObjectKeys(objectsAfterRetry), cloudflarePreviewObjectKeys(after))
	}
	if got := endpoint.putsForPreviewPrefix("_previews/sre/"); !equalStrings(putsAfterRetry, got) {
		t.Errorf("idempotent retry issued preview writes: before=%v after=%v", putsAfterRetry, got)
	}
	if after := endpoint.snapshotPrefix("_previews/docs/"); !cloudflarePreviewObjectsEqual(neighborBefore, after) {
		t.Errorf("SRE retry changed neighboring docs preview objects: before=%v after=%v", cloudflarePreviewObjectKeys(neighborBefore), cloudflarePreviewObjectKeys(after))
	}
	docsLockAfter, docsLockETagAfter, exists := endpoint.snapshot(siteLockKey("docs"))
	if !exists || docsLockETagAfter != docsLockETagBefore || !bytes.Equal(docsLockAfter.Bytes, docsLockBefore.Bytes) {
		t.Errorf("neighboring docs lock changed: ETag %q -> %q (exists=%t)", docsLockETagBefore, docsLockETagAfter, exists)
	}
}

func TestCloudflarePreviewIntegrationConcurrentGroupsKeepCatalogAndIsolateSites(t *testing.T) {
	backend, endpoint := newCloudflarePreviewIntegrationBackend(t)
	seedCloudflarePreviewRegistry(t, endpoint)
	seedCloudflarePreviewNeighbor(t, endpoint)
	neighborBefore := endpoint.snapshotPrefix("_previews/docs/")
	neighborLockBefore, neighborLockETagBefore, exists := endpoint.snapshot(siteLockKey("docs"))
	if !exists {
		t.Fatal("neighboring docs lock was not seeded")
	}

	_, options := cloudflarePreviewConcurrentBuildOptions(t)
	expected := make([]preview.BuildResult, 0, len(options))
	for _, buildOptions := range options {
		built, err := preview.BuildFromGit(context.Background(), buildOptions)
		if err != nil {
			t.Fatalf("BuildFromGit(%s) = %v", buildOptions.HeadRef, err)
		}
		expected = append(expected, built)
	}
	firstFileKey, err := preview.FileKey(expected[0].Site, expected[0].Manifest.HeadSHA, expected[0].Manifest.Documents[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	firstAtStorage := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondObservedHeldLock := make(chan struct{}, 1)
	var releaseOnce sync.Once
	releaseFirstPublish := func() { releaseOnce.Do(func() { close(releaseFirst) }) }
	var firstAtStorageOnce sync.Once
	endpoint.mu.Lock()
	endpoint.afterPut = func(key string) {
		if key == providerObjectKey(firstFileKey) {
			firstAtStorageOnce.Do(func() {
				close(firstAtStorage)
				<-releaseFirst
			})
		}
	}
	endpoint.afterGet = func(key string, object cloudflarePreviewS3Object) {
		if key != siteLockKey("sre") {
			return
		}
		var record lockRecord
		if json.Unmarshal(object.Bytes, &record) == nil && record.State == "held" {
			select {
			case secondObservedHeldLock <- struct{}{}:
			default:
			}
		}
	}
	endpoint.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	defer releaseFirstPublish()
	type outcome struct {
		result preview.BuildResult
		err    error
	}
	firstDone := make(chan outcome, 1)
	go func() {
		result, publishErr := BuildAndPublishPreview(ctx, backend, options[0])
		firstDone <- outcome{result: result, err: publishErr}
	}()
	select {
	case <-firstAtStorage:
	case <-ctx.Done():
		t.Fatalf("first Cloudflare preview publisher did not reach its immutable file write: %v", ctx.Err())
	}

	putsBeforeSecond := endpoint.putSnapshot()
	secondDone := make(chan outcome, 1)
	go func() {
		result, publishErr := BuildAndPublishPreview(ctx, backend, options[1])
		secondDone <- outcome{result: result, err: publishErr}
	}()
	select {
	case <-secondObservedHeldLock:
	case <-ctx.Done():
		t.Fatalf("second Cloudflare preview publisher did not observe the held site lock: %v", ctx.Err())
	}
	select {
	case result := <-firstDone:
		t.Fatalf("first Cloudflare preview publisher passed its storage barrier: %+v", result)
	default:
	}
	select {
	case result := <-secondDone:
		t.Fatalf("second Cloudflare preview publisher completed while the first held the lock: %+v", result)
	default:
	}
	if putsAfterSecond := endpoint.putSnapshot(); len(putsAfterSecond) != len(putsBeforeSecond) {
		t.Fatalf("second publisher made R2 writes while waiting for the SRE lock: before=%+v after=%+v", putsBeforeSecond, putsAfterSecond)
	}

	releaseFirstPublish()
	for _, done := range []struct {
		name string
		done <-chan outcome
	}{{name: "first", done: firstDone}, {name: "second", done: secondDone}} {
		select {
		case result := <-done.done:
			if result.err != nil || result.result.Outcome != preview.OutcomePublished {
				t.Errorf("%s Cloudflare preview publish = %+v, err=%v; want published", done.name, result.result, result.err)
			}
		case <-ctx.Done():
			t.Errorf("%s Cloudflare preview publisher did not finish after lock release: %v", done.name, ctx.Err())
		}
	}

	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}
	catalogObject, _, err := backend.GetObject(context.Background(), providerObjectKey(catalogKey))
	if err != nil {
		t.Fatalf("read final Cloudflare preview catalog: %v", err)
	}
	catalog, err := preview.DecodeCatalog(catalogObject.Bytes)
	if err != nil {
		t.Fatalf("decode final Cloudflare preview catalog: %v", err)
	}
	if len(catalog.Groups) != 2 {
		t.Fatalf("concurrent preview catalog groups = %+v; want both pull request groups", catalog.Groups)
	}
	wantGroups := map[string]string{expected[0].Group.ID: expected[0].Manifest.HeadSHA, expected[1].Group.ID: expected[1].Manifest.HeadSHA}
	gotGroups := make(map[string]string, len(catalog.Groups))
	for _, group := range catalog.Groups {
		if _, ok := wantGroups[group.ID]; !ok {
			t.Errorf("unexpected concurrent preview group %q", group.ID)
		}
		gotGroups[group.ID] = group.HeadSHA
	}
	for id, headSHA := range wantGroups {
		if gotGroups[id] != headSHA {
			t.Errorf("concurrent preview catalog head for %q = %q; want %q", id, gotGroups[id], headSHA)
		}
	}
	for _, want := range expected {
		manifestKey, keyErr := preview.ManifestKey(want.Site, want.Manifest.HeadSHA)
		if keyErr != nil {
			t.Fatal(keyErr)
		}
		if _, _, exists := endpoint.snapshot(providerObjectKey(manifestKey)); !exists {
			t.Errorf("revision manifest %q is missing", manifestKey)
		}
		for relativePath, contents := range want.Files {
			fileKey, keyErr := preview.FileKey(want.Site, want.Manifest.HeadSHA, relativePath)
			if keyErr != nil {
				t.Fatal(keyErr)
			}
			stored, _, exists := endpoint.snapshot(providerObjectKey(fileKey))
			if !exists || !bytes.Equal(stored.Bytes, contents) {
				t.Errorf("revision file %q = %q (exists=%t), want %q", fileKey, stored.Bytes, exists, contents)
			}
		}
	}
	if after := endpoint.snapshotPrefix("_previews/docs/"); !cloudflarePreviewObjectsEqual(neighborBefore, after) {
		t.Errorf("concurrent SRE preview publications changed neighboring docs objects: before=%v after=%v", cloudflarePreviewObjectKeys(neighborBefore), cloudflarePreviewObjectKeys(after))
	}
	docsLockAfter, docsLockETagAfter, exists := endpoint.snapshot(siteLockKey("docs"))
	if !exists || docsLockETagAfter != neighborLockETagBefore || !bytes.Equal(docsLockAfter.Bytes, neighborLockBefore.Bytes) {
		t.Errorf("neighboring docs lock changed during concurrent SRE publishes: ETag %q -> %q (exists=%t)", neighborLockETagBefore, docsLockETagAfter, exists)
	}
}

func TestCloudflarePreviewIntegrationLockLossPreventsCatalogWriteAndPreservesOtherSite(t *testing.T) {
	backend, endpoint := newCloudflarePreviewIntegrationBackend(t)
	seedCloudflarePreviewRegistry(t, endpoint)
	seedCloudflarePreviewNeighbor(t, endpoint)
	neighborBefore := endpoint.snapshotPrefix("_previews/docs/")
	docsLockBefore, docsLockETagBefore, _ := endpoint.snapshot(siteLockKey("docs"))

	root := createPreviewPublisherCheckout(t)
	options := cloudflarePreviewBuildOptions(t, root, "preview", 42)
	built, err := preview.BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit() = %v", err)
	}
	manifestKey, err := preview.ManifestKey(built.Site, built.Manifest.HeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	endpoint.replaceSiteLockAfterPut(providerObjectKey(manifestKey), "sre")

	_, err = BuildAndPublishPreview(context.Background(), backend, options)
	if err == nil || !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("Cloudflare BuildAndPublishPreview() after lock loss error = %v; want ErrPreconditionFailed", err)
	}
	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, exists := endpoint.snapshot(providerObjectKey(catalogKey)); exists {
		t.Fatal("stale Cloudflare publisher wrote the catalog after losing its site lock")
	}
	if _, _, exists := endpoint.snapshot(providerObjectKey(manifestKey)); !exists {
		t.Fatal("immutable revision manifest should remain available after catalog publication was fenced")
	}
	if after := endpoint.snapshotPrefix("_previews/docs/"); !cloudflarePreviewObjectsEqual(neighborBefore, after) {
		t.Errorf("SRE lock loss changed neighboring docs objects: before=%v after=%v", cloudflarePreviewObjectKeys(neighborBefore), cloudflarePreviewObjectKeys(after))
	}
	docsLockAfter, docsLockETagAfter, exists := endpoint.snapshot(siteLockKey("docs"))
	if !exists || docsLockETagAfter != docsLockETagBefore || !bytes.Equal(docsLockAfter.Bytes, docsLockBefore.Bytes) {
		t.Errorf("neighboring docs lock changed during SRE lock loss: ETag %q -> %q (exists=%t)", docsLockETagBefore, docsLockETagAfter, exists)
	}
}

func newCloudflarePreviewIntegrationBackend(t *testing.T) (*cloudflareBackend, *cloudflarePreviewS3Endpoint) {
	t.Helper()
	// Keep a 5xx injected by this endpoint visible as an interrupted object write
	// instead of allowing the AWS SDK's normal retryer to heal it inside one call.
	t.Setenv("AWS_MAX_ATTEMPTS", "1")
	endpoint := newCloudflarePreviewS3Endpoint()
	server := httptest.NewServer(endpoint)
	t.Cleanup(server.Close)
	backend, err := NewCloudflareBackend(context.Background(), CloudflareOptions{
		AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
		ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
		R2Endpoint: server.URL, APIBaseURL: server.URL + "/client/v4",
		AccessKeyID: "local-r2-access-key", SecretKey: "local-r2-secret-key", APIToken: "local-purge-token",
	})
	if err != nil {
		t.Fatalf("NewCloudflareBackend(local R2 endpoint): %v", err)
	}
	cloudflare, ok := backend.(*cloudflareBackend)
	if !ok {
		t.Fatalf("NewCloudflareBackend() type = %T, want *cloudflareBackend", backend)
	}
	if cloudflare.objects == nil || cloudflare.objects.bucket != "artifact-pages" {
		t.Fatalf("Cloudflare R2 object adapter = %+v; want configured bucket", cloudflare.objects)
	}
	return cloudflare, endpoint
}

func seedCloudflarePreviewRegistry(t *testing.T, endpoint *cloudflarePreviewS3Endpoint) {
	t.Helper()
	contents, _, err := testRegistryBuild(t, []byte(registeredSREAndDocsManifest))
	if err != nil {
		t.Fatalf("registry.Build() = %v", err)
	}
	endpoint.seed("_indexes/sites.json", Object{Bytes: contents, ContentType: "application/json"})
}

func seedCloudflarePreviewNeighbor(t *testing.T, endpoint *cloudflarePreviewS3Endpoint) {
	t.Helper()
	endpoint.seed("_previews/docs/catalog.json", Object{Bytes: []byte(`{"schemaVersion":1,"site":"docs","groups":[]}`), ContentType: "application/json"})
	endpoint.seed("_previews/docs/revisions/neighbor/manifest.json", Object{Bytes: []byte(`{"head":"neighbor"}`), ContentType: "application/json"})
	lockBytes, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: "docs", State: "free"})
	if err != nil {
		t.Fatal(err)
	}
	endpoint.seed(siteLockKey("docs"), Object{Bytes: lockBytes, ContentType: "application/json"})
}

func cloudflarePreviewBuildOptions(t *testing.T, root, headRef string, pullRequest int) preview.BuildOptions {
	t.Helper()
	headSHA := cloudflarePreviewGitOutput(t, root, "rev-parse", headRef)
	return preview.BuildOptions{
		RepositoryDir: root, SiteID: "sre", SourcePath: "docs/artifacts", DefaultRef: "main", HeadRef: headRef,
		Repository: "acme/sre", PullRequestURL: fmt.Sprintf("https://github.com/acme/sre/pull/%d", pullRequest),
		PullRequestHeadRepository: "acme/sre", PullRequestHeadSHA: headSHA,
	}
}

func cloudflarePreviewConcurrentBuildOptions(t *testing.T) (string, []preview.BuildOptions) {
	t.Helper()
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := runPublisherGitAt(root, "branch", "-M", "main"); err != nil {
		t.Fatal(err)
	}
	options := make([]preview.BuildOptions, 0, 2)
	for _, entry := range []struct {
		pullRequest int
		ref         string
	}{{pullRequest: 42, ref: "preview-42"}, {pullRequest: 43, ref: "preview-43"}} {
		pullRequest, ref := entry.pullRequest, entry.ref
		if err := runPublisherGitAt(root, "checkout", "-b", ref, "main"); err != nil {
			t.Fatal(err)
		}
		report := fmt.Sprintf("<title>Preview %d</title><h1>Preview %d</h1>", pullRequest, pullRequest)
		if err := os.WriteFile(filepath.Join(root, "docs/artifacts/report.html"), []byte(report), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := runPublisherGitAt(root, "add", "docs/artifacts/report.html"); err != nil {
			t.Fatal(err)
		}
		if err := runPublisherGitAt(root, "commit", "--quiet", "-m", fmt.Sprintf("update preview %d", pullRequest)); err != nil {
			t.Fatal(err)
		}
		options = append(options, cloudflarePreviewBuildOptions(t, root, ref, pullRequest))
	}
	return root, options
}

func cloudflarePreviewGitOutput(t *testing.T, root string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-C", root}, args...)...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

type cloudflarePreviewS3Object struct {
	Object
	etag string
}

type cloudflarePreviewS3Endpoint struct {
	mu                     sync.Mutex
	objects                map[string]cloudflarePreviewS3Object
	nextETag               int
	failedPuts             map[string]int
	replaceLockAfterPutKey string
	replaceLockSite        string
	puts                   []string
	afterPut               func(string)
	afterGet               func(string, cloudflarePreviewS3Object)
}

func newCloudflarePreviewS3Endpoint() *cloudflarePreviewS3Endpoint {
	return &cloudflarePreviewS3Endpoint{objects: make(map[string]cloudflarePreviewS3Object), failedPuts: make(map[string]int)}
}

func (endpoint *cloudflarePreviewS3Endpoint) seed(key string, object Object) {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	endpoint.nextETag++
	endpoint.objects[key] = cloudflarePreviewS3Object{Object: cloneCloudflarePreviewObject(object), etag: fmt.Sprintf(`"r2-seed-%d"`, endpoint.nextETag)}
}

func (endpoint *cloudflarePreviewS3Endpoint) failNextPut(key string) {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	endpoint.failedPuts[key]++
}

func (endpoint *cloudflarePreviewS3Endpoint) replaceSiteLockAfterPut(key, site string) {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	endpoint.replaceLockAfterPutKey, endpoint.replaceLockSite = key, site
}

func (endpoint *cloudflarePreviewS3Endpoint) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	key, ok := cloudflarePreviewS3Key(request.URL.EscapedPath())
	if !ok {
		writeCloudflarePreviewS3Error(writer, http.StatusNotFound, "NoSuchBucket", "bucket not found")
		return
	}
	if request.Method == http.MethodGet && request.URL.Query().Get("list-type") == "2" {
		endpoint.list(writer, request)
		return
	}
	if _, isDelete := request.URL.Query()["delete"]; isDelete {
		endpoint.delete(writer, request)
		return
	}
	switch request.Method {
	case http.MethodGet:
		endpoint.read(writer, key, false)
	case http.MethodHead:
		endpoint.read(writer, key, true)
	case http.MethodPut:
		endpoint.put(writer, request, key)
	default:
		writeCloudflarePreviewS3Error(writer, http.StatusMethodNotAllowed, "MethodNotAllowed", "unsupported S3 method")
	}
}

func cloudflarePreviewS3Key(rawPath string) (string, bool) {
	path := strings.TrimPrefix(rawPath, "/")
	if path == "artifact-pages" {
		return "", true
	}
	key, found := strings.CutPrefix(path, "artifact-pages/")
	if !found || key == "" {
		return "", false
	}
	unescaped, err := url.PathUnescape(key)
	return unescaped, err == nil
}

func (endpoint *cloudflarePreviewS3Endpoint) read(writer http.ResponseWriter, key string, headOnly bool) {
	endpoint.mu.Lock()
	object, exists := endpoint.objects[key]
	afterGet := endpoint.afterGet
	endpoint.mu.Unlock()
	if !exists {
		writeCloudflarePreviewS3Error(writer, http.StatusNotFound, "NoSuchKey", "object not found")
		return
	}
	if !headOnly && afterGet != nil {
		afterGet(key, object)
	}
	writeCloudflarePreviewObjectHeaders(writer, object)
	if !headOnly {
		_, _ = writer.Write(object.Bytes)
	}
}

func (endpoint *cloudflarePreviewS3Endpoint) put(writer http.ResponseWriter, request *http.Request, key string) {
	contents, err := io.ReadAll(request.Body)
	if err != nil {
		writeCloudflarePreviewS3Error(writer, http.StatusBadRequest, "InvalidRequest", "could not read object body")
		return
	}
	endpoint.mu.Lock()
	endpoint.puts = append(endpoint.puts, key)
	if endpoint.failedPuts[key] > 0 {
		endpoint.failedPuts[key]--
		endpoint.mu.Unlock()
		writeCloudflarePreviewS3Error(writer, http.StatusInternalServerError, "InternalError", "injected interrupted R2 write")
		return
	}
	current, exists := endpoint.objects[key]
	if request.Header.Get("If-None-Match") == "*" && exists || request.Header.Get("If-Match") != "" && (!exists || request.Header.Get("If-Match") != current.etag) {
		endpoint.mu.Unlock()
		writeCloudflarePreviewS3Error(writer, http.StatusPreconditionFailed, "PreconditionFailed", "conditional write did not match")
		return
	}
	endpoint.nextETag++
	etag := fmt.Sprintf(`"r2-%d"`, endpoint.nextETag)
	object := Object{
		Bytes: contents, ContentType: request.Header.Get("Content-Type"),
		ContentDisposition: request.Header.Get("Content-Disposition"), ContentEncoding: request.Header.Get("Content-Encoding"),
		Cache: request.Header.Get("Cache-Control"), Metadata: cloudflarePreviewMetadata(request.Header),
	}
	endpoint.objects[key] = cloudflarePreviewS3Object{Object: object, etag: etag}
	if key == endpoint.replaceLockAfterPutKey && endpoint.replaceLockSite != "" {
		lockSite := endpoint.replaceLockSite
		lockContents, marshalErr := marshalLockRecord(lockRecord{
			SchemaVersion: 1, Site: lockSite, State: "held", Owner: "replacement-owner", AcquiredAt: time.Now().UTC(),
		})
		if marshalErr == nil {
			endpoint.nextETag++
			endpoint.objects[siteLockKey(lockSite)] = cloudflarePreviewS3Object{
				Object: Object{Bytes: lockContents, ContentType: "application/json"},
				etag:   fmt.Sprintf(`"r2-replacement-%d"`, endpoint.nextETag),
			}
			endpoint.replaceLockAfterPutKey, endpoint.replaceLockSite = "", ""
		}
	}
	afterPut := endpoint.afterPut
	endpoint.mu.Unlock()
	if afterPut != nil {
		afterPut(key)
	}
	writer.Header().Set("ETag", etag)
	writer.WriteHeader(http.StatusOK)
}

func (endpoint *cloudflarePreviewS3Endpoint) list(writer http.ResponseWriter, request *http.Request) {
	prefix := request.URL.Query().Get("prefix")
	endpoint.mu.Lock()
	keys := make([]string, 0)
	for key := range endpoint.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	objects := make(map[string]cloudflarePreviewS3Object, len(keys))
	for _, key := range keys {
		objects[key] = endpoint.objects[key]
	}
	endpoint.mu.Unlock()
	sort.Strings(keys)
	result := struct {
		XMLName     xml.Name `xml:"ListBucketResult"`
		Name        string   `xml:"Name"`
		Prefix      string   `xml:"Prefix"`
		KeyCount    int      `xml:"KeyCount"`
		MaxKeys     int      `xml:"MaxKeys"`
		IsTruncated bool     `xml:"IsTruncated"`
		Contents    []struct {
			Key          string `xml:"Key"`
			LastModified string `xml:"LastModified"`
			ETag         string `xml:"ETag"`
			Size         int    `xml:"Size"`
			StorageClass string `xml:"StorageClass"`
		} `xml:"Contents"`
	}{Name: "artifact-pages", Prefix: prefix, KeyCount: len(keys), MaxKeys: 1000, IsTruncated: false}
	for _, key := range keys {
		object := objects[key]
		result.Contents = append(result.Contents, struct {
			Key          string `xml:"Key"`
			LastModified string `xml:"LastModified"`
			ETag         string `xml:"ETag"`
			Size         int    `xml:"Size"`
			StorageClass string `xml:"StorageClass"`
		}{Key: key, LastModified: "2026-01-02T03:04:05.000Z", ETag: object.etag, Size: len(object.Bytes), StorageClass: "STANDARD"})
	}
	writer.Header().Set("Content-Type", "application/xml")
	_ = xml.NewEncoder(writer).Encode(result)
}

func (endpoint *cloudflarePreviewS3Endpoint) delete(writer http.ResponseWriter, request *http.Request) {
	contents, err := io.ReadAll(request.Body)
	if err != nil {
		writeCloudflarePreviewS3Error(writer, http.StatusBadRequest, "InvalidRequest", "could not read delete body")
		return
	}
	var payload struct {
		Objects []struct {
			Key string `xml:"Key"`
		} `xml:"Object"`
	}
	if err := xml.Unmarshal(contents, &payload); err != nil {
		writeCloudflarePreviewS3Error(writer, http.StatusBadRequest, "MalformedXML", "invalid delete body")
		return
	}
	endpoint.mu.Lock()
	for _, object := range payload.Objects {
		delete(endpoint.objects, object.Key)
	}
	endpoint.mu.Unlock()
	writer.Header().Set("Content-Type", "application/xml")
	_, _ = io.WriteString(writer, "<DeleteResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"></DeleteResult>")
}

func writeCloudflarePreviewObjectHeaders(writer http.ResponseWriter, object cloudflarePreviewS3Object) {
	writer.Header().Set("ETag", object.etag)
	writer.Header().Set("Content-Length", fmt.Sprint(len(object.Bytes)))
	if object.ContentType != "" {
		writer.Header().Set("Content-Type", object.ContentType)
	}
	if object.ContentDisposition != "" {
		writer.Header().Set("Content-Disposition", object.ContentDisposition)
	}
	if object.ContentEncoding != "" {
		writer.Header().Set("Content-Encoding", object.ContentEncoding)
	}
	if object.Cache != "" {
		writer.Header().Set("Cache-Control", object.Cache)
	}
	for key, value := range object.Metadata {
		writer.Header().Set("x-amz-meta-"+key, value)
	}
}

func writeCloudflarePreviewS3Error(writer http.ResponseWriter, status int, code, message string) {
	writer.Header().Set("Content-Type", "application/xml")
	writer.WriteHeader(status)
	_, _ = fmt.Fprintf(writer, "<Error><Code>%s</Code><Message>%s</Message><Resource>/artifact-pages</Resource></Error>", code, message)
}

func cloudflarePreviewMetadata(header http.Header) map[string]string {
	metadata := make(map[string]string)
	for key, values := range header {
		lower := strings.ToLower(key)
		if !strings.HasPrefix(lower, "x-amz-meta-") || len(values) == 0 {
			continue
		}
		metadata[strings.TrimPrefix(lower, "x-amz-meta-")] = values[0]
	}
	return metadata
}

func (endpoint *cloudflarePreviewS3Endpoint) snapshot(key string) (Object, string, bool) {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	object, exists := endpoint.objects[key]
	if !exists {
		return Object{}, "", false
	}
	return cloneCloudflarePreviewObject(object.Object), object.etag, true
}

func (endpoint *cloudflarePreviewS3Endpoint) snapshotPrefix(prefix string) map[string]cloudflarePreviewS3Object {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	result := make(map[string]cloudflarePreviewS3Object)
	for key, object := range endpoint.objects {
		if strings.HasPrefix(key, prefix) {
			result[key] = cloudflarePreviewS3Object{Object: cloneCloudflarePreviewObject(object.Object), etag: object.etag}
		}
	}
	return result
}

func (endpoint *cloudflarePreviewS3Endpoint) putsForPreviewPrefix(prefix string) []string {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	var puts []string
	for _, key := range endpoint.puts {
		if strings.HasPrefix(key, prefix) {
			puts = append(puts, key)
		}
	}
	return puts
}

func (endpoint *cloudflarePreviewS3Endpoint) putSnapshot() []string {
	endpoint.mu.Lock()
	defer endpoint.mu.Unlock()
	return append([]string(nil), endpoint.puts...)
}

func cloudflarePreviewObjectsEqual(left, right map[string]cloudflarePreviewS3Object) bool {
	if len(left) != len(right) {
		return false
	}
	for key, before := range left {
		after, exists := right[key]
		if !exists || before.etag != after.etag || !bytes.Equal(before.Bytes, after.Bytes) {
			return false
		}
	}
	return true
}

func cloudflarePreviewObjectKeys(objects map[string]cloudflarePreviewS3Object) []string {
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func cloneCloudflarePreviewObject(object Object) Object {
	clone := object
	clone.Bytes = append([]byte(nil), object.Bytes...)
	clone.Metadata = make(map[string]string, len(object.Metadata))
	for key, value := range object.Metadata {
		clone.Metadata[key] = value
	}
	return clone
}

func equalStrings(left, right []string) bool {
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
