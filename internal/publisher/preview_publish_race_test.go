package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/tasuku43/git-artifact-pages/internal/preview"
	"github.com/tasuku43/git-artifact-pages/internal/registry"
)

func TestBuildAndPublishPreviewFirstThenUnregisterCleansPreview(t *testing.T) {
	root := createPreviewPublisherCheckout(t)
	backend := newPreviewPublishRaceBackend()
	seedPublisherRegistry(t, backend.siteUnregisterRaceBackend.lockMemoryBackend, registeredSREAndDocsManifest)
	seedSiteUnregisterProjectionFixtures(t, backend.siteUnregisterRaceBackend.lockMemoryBackend)
	backend.pauseFirstRegistryRead.Store(true)

	var releaseOnce sync.Once
	releasePublisherRead := func() { releaseOnce.Do(func() { close(backend.releaseRegistryRead) }) }
	type publishOutcome struct {
		result preview.BuildResult
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
			awaitOperationCleanup(t, "preview publish", publishStopped)
		}
		if unregisterPending {
			awaitOperationCleanup(t, "preview unregister", unregisterStopped)
		}
	}()
	go func() {
		defer close(publishStopped)
		result, err := BuildAndPublishPreview(context.Background(), backend, previewBuildOptions(root))
		publishDone <- publishOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.registryReadReached, "preview publisher's post-lock registry read")

	unregisterPending = true
	go func() {
		defer close(unregisterStopped)
		result, err := UnregisterSite(context.Background(), backend, []byte(docsOnlyManifest), "sre", false)
		unregisterDone <- unregisterOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.registryWriteReached, "registry withdrawal while preview publisher holds its site lock")
	awaitSiteSignal(t, backend.siteLockWaitReached, "unregister waiting for preview publisher's site lock")
	registryObject, _, err := backend.siteUnregisterRaceBackend.lockMemoryBackend.GetObject(context.Background(), "_indexes/sites.json")
	if err != nil {
		t.Fatalf("read withdrawn origin registry: %v", err)
	}
	projection, err := decodeTestRegistry(registryObject.Bytes)
	if err != nil || len(projection) != 1 || projection[0] != "docs" {
		t.Fatalf("registry while preview publisher holds lock = %v, err=%v; want only neighboring registration", projection, err)
	}
	select {
	case outcome := <-unregisterDone:
		unregisterPending = false
		awaitOperationCleanup(t, "preview unregister", unregisterStopped)
		t.Fatalf("unregister completed before the preview publisher released its lock: %+v", outcome)
	default:
	}

	releasePublisherRead()
	select {
	case outcome := <-publishDone:
		publishPending = false
		awaitOperationCleanup(t, "preview publish", publishStopped)
		if outcome.err != nil || outcome.result.Outcome != preview.OutcomePublished {
			t.Fatalf("preview publish-first result = %+v, err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("preview publisher did not finish after its registry read was released")
	}
	select {
	case outcome := <-unregisterDone:
		unregisterPending = false
		awaitOperationCleanup(t, "preview unregister", unregisterStopped)
		if outcome.err != nil || outcome.result.Outcome != "unregistered" {
			t.Fatalf("preview unregister result = %+v, err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unregister did not finish after preview publisher released the site lock")
	}
	if attempts := backend.previewWriteAttempts(); len(attempts) == 0 {
		t.Fatal("publish-first ordering performed no preview writes")
	}
	assertSiteIsUnregisteredAndEmpty(t, backend.siteUnregisterRaceBackend.lockMemoryBackend)
}

func TestUnregisterFirstRejectsPreviewPublisherAfterLockAndBeforeUpload(t *testing.T) {
	root := createPreviewPublisherCheckout(t)
	backend := newPreviewPublishRaceBackend()
	seedPublisherRegistry(t, backend.siteUnregisterRaceBackend.lockMemoryBackend, registeredSREAndDocsManifest)
	seedSiteUnregisterProjectionFixtures(t, backend.siteUnregisterRaceBackend.lockMemoryBackend)
	backend.pauseCleanupListing.Store(true)

	type unregisterOutcome struct {
		result Result
		err    error
	}
	type publishOutcome struct {
		result preview.BuildResult
		err    error
	}
	unregisterDone := make(chan unregisterOutcome, 1)
	unregisterStopped := make(chan struct{})
	unregisterPending := true
	publishDone := make(chan publishOutcome, 1)
	publishStopped := make(chan struct{})
	publishPending := false
	var releaseOnce sync.Once
	releaseCleanupListing := func() { releaseOnce.Do(func() { close(backend.releaseCleanupListing) }) }
	defer func() {
		releaseCleanupListing()
		if unregisterPending {
			awaitOperationCleanup(t, "preview unregister", unregisterStopped)
		}
		if publishPending {
			awaitOperationCleanup(t, "preview publish", publishStopped)
		}
	}()
	go func() {
		defer close(unregisterStopped)
		result, err := UnregisterSite(context.Background(), backend, []byte(docsOnlyManifest), "sre", false)
		unregisterDone <- unregisterOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.registryWriteReached, "registry withdrawal")
	awaitSiteSignal(t, backend.cleanupListingReached, "unregister holding the site lock before cleanup")

	publishPending = true
	go func() {
		defer close(publishStopped)
		result, err := BuildAndPublishPreview(context.Background(), backend, previewBuildOptions(root))
		publishDone <- publishOutcome{result: result, err: err}
	}()
	awaitSiteSignal(t, backend.siteLockWaitReached, "preview publisher waiting behind unregister's site lock")
	select {
	case outcome := <-publishDone:
		publishPending = false
		awaitOperationCleanup(t, "preview publish", publishStopped)
		t.Fatalf("preview publisher completed while unregister held the site lock: %+v", outcome)
	case <-time.After(150 * time.Millisecond):
	}
	if attempts := backend.previewWriteAttempts(); len(attempts) != 0 {
		t.Fatalf("preview publisher wrote objects while blocked by unregister: %v", attempts)
	}

	releaseCleanupListing()
	select {
	case outcome := <-unregisterDone:
		unregisterPending = false
		awaitOperationCleanup(t, "preview unregister", unregisterStopped)
		if outcome.err != nil || outcome.result.Outcome != "unregistered" {
			t.Fatalf("unregister-first result = %+v, err=%v", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("unregister did not finish after cleanup listing resumed")
	}
	select {
	case outcome := <-publishDone:
		publishPending = false
		awaitOperationCleanup(t, "preview publish", publishStopped)
		if outcome.err == nil || !strings.Contains(outcome.err.Error(), "is not registered") {
			t.Fatalf("preview publisher after unregister = %+v, err=%v; want registry rejection", outcome.result, outcome.err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("preview publisher did not finish after unregister released the site lock")
	}
	if attempts := backend.previewWriteAttempts(); len(attempts) != 0 {
		t.Fatalf("rejected preview publisher attempted uploads after withdrawal: %v", attempts)
	}
	assertSiteIsUnregisteredAndEmpty(t, backend.siteUnregisterRaceBackend.lockMemoryBackend)
	operations := backend.siteUnregisterRaceBackend.operationSnapshot()
	if lockIndex, registryIndex := secondOperationIndex(operations, "lock-held:"+siteLockKey("sre")), secondOperationIndex(operations, "get:_indexes/sites.json"); lockIndex < 0 || registryIndex < 0 || lockIndex > registryIndex {
		t.Fatalf("preview publisher did not revalidate the registry after acquiring the site lock: %v", operations)
	}
}

func TestUnregisterSiteCleansEveryAWSListingPageWithFakeBackend(t *testing.T) {
	manifestBytes, _, err := registry.Build([]byte(registeredSREAndDocsManifest))
	if err != nil {
		t.Fatal(err)
	}
	client := newAWSUnregisterPagedFake(2)
	client.seed("_indexes/sites.json", manifestBytes)
	for key, contents := range map[string][]byte{
		"_artifacts/sre/one.html":              []byte("one"),
		"_artifacts/sre/two.html":              []byte("two"),
		"_artifacts/sre/three.html":            []byte("three"),
		"_indexes/sre/meta.json":               []byte(`{"site":"sre"}`),
		"_indexes/sre/index.json":              []byte(`{"site":"sre"}`),
		"_indexes/sre/extra.json":              []byte(`{"extra":true}`),
		"_previews/sre/catalog.json":           []byte(`{"site":"sre"}`),
		"_previews/sre/revisions/one/manifest": []byte(`{"head":"one"}`),
		"_previews/sre/revisions/two/file":     []byte("preview bytes"),
		"_artifacts/docs/neighbor.html":        []byte("neighbor"),
		"_previews/docs/catalog.json":          []byte(`{"site":"docs"}`),
	} {
		client.seed(key, contents)
	}
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-test"})
	if err != nil {
		t.Fatal(err)
	}

	result, err := UnregisterSite(context.Background(), backend, []byte(docsOnlyManifest), "sre", false)
	if err != nil || result.Outcome != "unregistered" {
		t.Fatalf("UnregisterSite() = %+v, err=%v; want successful cleanup", result, err)
	}
	for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", "_previews/sre/"} {
		if count := client.listCount(prefix); count < 2 {
			t.Errorf("S3 listing pages read for %q = %d, want at least two", prefix, count)
		}
	}
	for _, key := range []string{"_artifacts/docs/neighbor.html", "_previews/docs/catalog.json"} {
		if _, exists := client.objects[key]; !exists {
			t.Errorf("neighbor object %q was removed", key)
		}
	}
	for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", "_previews/sre/"} {
		for key := range client.objects {
			if strings.HasPrefix(key, prefix) {
				t.Errorf("site object %q remains after all pages were cleaned", key)
			}
		}
	}
}

func TestUnregisterSiteRetriesAfterAWSContinuationListingFailure(t *testing.T) {
	manifestBytes, _, err := registry.Build([]byte(registeredSREAndDocsManifest))
	if err != nil {
		t.Fatal(err)
	}
	client := newAWSUnregisterPagedFake(1)
	client.seed("_indexes/sites.json", manifestBytes)
	for key, contents := range map[string][]byte{
		"_artifacts/sre/one.html":                 []byte("one"),
		"_artifacts/sre/two.html":                 []byte("two"),
		"_artifacts/sre/three.html":               []byte("three"),
		"_indexes/sre/one.json":                   []byte(`{"one":true}`),
		"_indexes/sre/two.json":                   []byte(`{"two":true}`),
		"_indexes/sre/three.json":                 []byte(`{"three":true}`),
		"_previews/sre/catalog.json":              []byte(`{"site":"sre"}`),
		"_previews/sre/revisions/one/manifest":    []byte(`{"head":"one"}`),
		"_previews/sre/revisions/two/files/a.txt": []byte("preview bytes"),
		"_artifacts/docs/neighbor.html":           []byte("neighbor artifact"),
		"_indexes/docs/meta.json":                 []byte(`{"site":"docs"}`),
		"_previews/docs/catalog.json":             []byte(`{"site":"docs"}`),
		"index.html":                              []byte("application shell"),
		"assets/app.js":                           []byte("application asset"),
		"_control/private/sentinel":               []byte("private control data"),
	} {
		client.seed(key, contents)
	}
	for _, siteID := range []string{"sre", "docs", "registry"} {
		contents, marshalErr := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: siteID, State: "free"})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		key := "_control/locks/registry.json"
		if siteID != "registry" {
			key = siteLockKey(siteID)
		}
		client.seed(key, contents)
	}
	client.failContinuationPrefix = "_previews/sre/"
	client.failContinuationOnce = true
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-test"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}

	_, err = UnregisterSite(context.Background(), backend, []byte(docsOnlyManifest), "sre", false)
	if err == nil || !strings.Contains(err.Error(), "injected AWS continuation-page listing failure") {
		t.Fatalf("first UnregisterSite() error = %v, want continuation-page listing failure", err)
	}
	if client.deleteCalls != 0 {
		t.Fatalf("DeleteObjects calls after incomplete preview listing = %d, want zero", client.deleteCalls)
	}
	if client.listCount("_previews/sre/") != 2 {
		t.Fatalf("preview listing calls before failure = %d, want first page plus failed continuation", client.listCount("_previews/sre/"))
	}
	for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", "_previews/sre/"} {
		found := 0
		for key := range client.objects {
			if strings.HasPrefix(key, prefix) {
				found++
			}
		}
		if found != 3 {
			t.Errorf("site object count after failed listing under %q = %d, want all three retained", prefix, found)
		}
	}
	registryAfterFailure := client.objects["_indexes/sites.json"]
	projection, err := registry.DecodeProjection(registryAfterFailure.bytes)
	if err != nil || len(projection.Sites) != 1 || projection.Sites[0].ID != "docs" {
		t.Fatalf("registry after cleanup listing failure = %+v, err=%v; want withdrawal retained for retry", projection, err)
	}
	if _, exists := client.objects[registryCleanupKey]; !exists {
		t.Fatal("cleanup retry record is missing after listing failure")
	}

	result, err := UnregisterSite(context.Background(), backend, []byte(docsOnlyManifest), "sre", false)
	if err != nil || result.Outcome != "unregistered" {
		t.Fatalf("retry UnregisterSite() = %+v, err=%v; want successful cleanup", result, err)
	}
	if client.deleteCalls == 0 {
		t.Fatal("retry did not delete any objects")
	}
	registryAfterRetry := client.objects["_indexes/sites.json"]
	projection, err = registry.DecodeProjection(registryAfterRetry.bytes)
	if err != nil || len(projection.Sites) != 1 || projection.Sites[0].ID != "docs" {
		t.Fatalf("registry after retry = %+v, err=%v; want neighboring registration preserved", projection, err)
	}
	for _, prefix := range []string{"_artifacts/sre/", "_indexes/sre/", "_previews/sre/"} {
		for key := range client.objects {
			if strings.HasPrefix(key, prefix) {
				t.Errorf("target site object %q remains after retry", key)
			}
		}
		if client.listCount(prefix) < 4 {
			t.Errorf("listing calls for %q = %d, want failed attempt plus all retry pages", prefix, client.listCount(prefix))
		}
	}
	for key, want := range map[string]string{
		"_artifacts/docs/neighbor.html": "neighbor artifact",
		"_indexes/docs/meta.json":       `{"site":"docs"}`,
		"_previews/docs/catalog.json":   `{"site":"docs"}`,
		"index.html":                    "application shell",
		"assets/app.js":                 "application asset",
		"_control/private/sentinel":     "private control data",
	} {
		object, exists := client.objects[key]
		if !exists || string(object.bytes) != want {
			t.Errorf("preserved object %q = %q, exists=%t; want %q", key, object.bytes, exists, want)
		}
	}
	for _, key := range []string{siteLockKey("sre"), siteLockKey("docs"), "_control/locks/registry.json"} {
		object, exists := client.objects[key]
		var record lockRecord
		if !exists || json.Unmarshal(object.bytes, &record) != nil || record.State != "free" {
			t.Errorf("control lock %q = %+v, exists=%t; want retained free lock", key, record, exists)
		}
	}
	if _, exists := client.objects[registryCleanupKey]; exists {
		t.Error("cleanup retry record remains after successful retry")
	}
}

type previewPublishRaceBackend struct {
	*siteUnregisterRaceBackend
	writesMu      sync.Mutex
	previewWrites []string
}

func newPreviewPublishRaceBackend() *previewPublishRaceBackend {
	return &previewPublishRaceBackend{siteUnregisterRaceBackend: newSiteUnregisterRaceBackend()}
}

func (backend *previewPublishRaceBackend) PutObject(ctx context.Context, key string, object Object) error {
	backend.recordPreviewWrite(key)
	return backend.siteUnregisterRaceBackend.PutObject(ctx, key, object)
}

func (backend *previewPublishRaceBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.recordPreviewWrite(key)
	return backend.siteUnregisterRaceBackend.PutObjectConditional(ctx, key, object, condition)
}

func (backend *previewPublishRaceBackend) recordPreviewWrite(key string) {
	if !strings.HasPrefix(key, "_previews/sre/") {
		return
	}
	backend.writesMu.Lock()
	backend.previewWrites = append(backend.previewWrites, key)
	backend.writesMu.Unlock()
}

func (backend *previewPublishRaceBackend) previewWriteAttempts() []string {
	backend.writesMu.Lock()
	defer backend.writesMu.Unlock()
	return append([]string(nil), backend.previewWrites...)
}

func createPreviewPublisherCheckout(t *testing.T) string {
	t.Helper()
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := runPublisherGit("branch", "-M", "main"); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGit("checkout", "-b", "preview"); err != nil {
		t.Fatal(err)
	}
	reportPath := filepath.Join(root, "docs", "artifacts", "report.html")
	if err := os.WriteFile(reportPath, []byte("<title>Preview Report</title><h1>Preview Report</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGit("add", "docs/artifacts/report.html"); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGit("commit", "--quiet", "-m", "update preview report"); err != nil {
		t.Fatal(err)
	}
	return root
}

func previewBuildOptions(root string) preview.BuildOptions {
	return preview.BuildOptions{
		RepositoryDir: root,
		SiteID:        "sre",
		SourcePath:    "docs/artifacts",
		DefaultRef:    "main",
		HeadRef:       "preview",
	}
}

func decodeTestRegistry(contents []byte) ([]string, error) {
	projection, err := registry.DecodeProjection(contents)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(projection.Sites))
	for _, entry := range projection.Sites {
		ids = append(ids, entry.ID)
	}
	return ids, nil
}

func secondOperationIndex(operations []string, target string) int {
	seen := 0
	for index, operation := range operations {
		if operation == target {
			seen++
			if seen == 2 {
				return index
			}
		}
	}
	return -1
}

type awsUnregisterPagedObject struct {
	bytes []byte
	etag  string
}

type awsUnregisterPagedFake struct {
	objects                map[string]awsUnregisterPagedObject
	pageSize               int
	nextETag               int
	listCounts             map[string]int
	failContinuationPrefix string
	failContinuationOnce   bool
	deleteCalls            int
}

func newAWSUnregisterPagedFake(pageSize int) *awsUnregisterPagedFake {
	return &awsUnregisterPagedFake{objects: make(map[string]awsUnregisterPagedObject), pageSize: pageSize, listCounts: make(map[string]int)}
}

func (client *awsUnregisterPagedFake) seed(key string, contents []byte) {
	client.nextETag++
	client.objects[key] = awsUnregisterPagedObject{bytes: append([]byte(nil), contents...), etag: fmt.Sprintf("\"seed-%d\"", client.nextETag)}
}

func (client *awsUnregisterPagedFake) PutObject(ctx context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	current, exists := client.objects[key]
	if input.IfNoneMatch != nil && aws.ToString(input.IfNoneMatch) == "*" && exists || input.IfMatch != nil && (!exists || current.etag != aws.ToString(input.IfMatch)) {
		return nil, awsUnregisterPreconditionError()
	}
	contents, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	client.nextETag++
	etag := fmt.Sprintf("\"fake-%d\"", client.nextETag)
	client.objects[key] = awsUnregisterPagedObject{bytes: append([]byte(nil), contents...), etag: etag}
	return &s3.PutObjectOutput{ETag: aws.String(etag)}, nil
}

func (client *awsUnregisterPagedFake) ListObjectsV2(ctx context.Context, input *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	prefix := aws.ToString(input.Prefix)
	keys := make([]string, 0)
	for key := range client.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	start := 0
	if input.ContinuationToken != nil {
		var err error
		start, err = strconv.Atoi(aws.ToString(input.ContinuationToken))
		if err != nil || start < 0 || start > len(keys) {
			return nil, fmt.Errorf("invalid fake continuation token %q", aws.ToString(input.ContinuationToken))
		}
	}
	if prefix == client.failContinuationPrefix && input.ContinuationToken != nil && client.failContinuationOnce {
		client.listCounts[prefix]++
		client.failContinuationOnce = false
		return nil, errors.New("injected AWS continuation-page listing failure")
	}
	end := min(start+client.pageSize, len(keys))
	contents := make([]types.Object, 0, end-start)
	for _, key := range keys[start:end] {
		contents = append(contents, types.Object{Key: aws.String(key)})
	}
	client.listCounts[prefix]++
	result := &s3.ListObjectsV2Output{Contents: contents, IsTruncated: aws.Bool(end < len(keys))}
	if end < len(keys) {
		result.NextContinuationToken = aws.String(strconv.Itoa(end))
	}
	return result, nil
}

func (client *awsUnregisterPagedFake) DeleteObjects(ctx context.Context, input *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	client.deleteCalls++
	for _, object := range input.Delete.Objects {
		delete(client.objects, aws.ToString(object.Key))
	}
	return &s3.DeleteObjectsOutput{}, nil
}

func (client *awsUnregisterPagedFake) GetObject(ctx context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	object, exists := client.objects[aws.ToString(input.Key)]
	if !exists {
		return nil, awsUnregisterNotFoundError()
	}
	return &s3.GetObjectOutput{Body: io.NopCloser(bytes.NewReader(object.bytes)), ETag: aws.String(object.etag)}, nil
}

func (client *awsUnregisterPagedFake) HeadObject(ctx context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	object, exists := client.objects[aws.ToString(input.Key)]
	if !exists {
		return nil, awsUnregisterNotFoundError()
	}
	return &s3.HeadObjectOutput{ETag: aws.String(object.etag), ContentLength: aws.Int64(int64(len(object.bytes)))}, nil
}

func (client *awsUnregisterPagedFake) listCount(prefix string) int {
	return client.listCounts[prefix]
}

func awsUnregisterNotFoundError() error {
	return s3ResponseError(http.StatusNotFound, "NoSuchKey")
}

func awsUnregisterPreconditionError() error {
	return &smithyhttp.ResponseError{Response: &smithyhttp.Response{Response: &http.Response{StatusCode: http.StatusPreconditionFailed}}, Err: errors.New("fake precondition failed")}
}
