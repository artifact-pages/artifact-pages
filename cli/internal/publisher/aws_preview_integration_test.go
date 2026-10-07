package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// These tests compose awsBackend and ObjectPreviewStore over a deterministic
// fake S3 API. They prove request mapping and retry behavior, not live S3 races.
func TestAWSPreviewIntegrationRevalidatesOriginRegistryBeforeUploading(t *testing.T) {
	root := createPreviewPublisherCheckout(t)
	client := newAWSPreviewIntegrationS3()
	awsPreviewIntegrationSeedRegistry(t, client, docsOnlyManifest)
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "preview-test"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}

	result, err := BuildAndPublishPreview(context.Background(), backend, previewBuildOptions(root))
	if err == nil || !strings.Contains(err.Error(), `site "sre" is not registered`) {
		t.Fatalf("BuildAndPublishPreview() = %+v, %v; want origin registry rejection", result, err)
	}
	operations := client.operationSnapshot()
	lockIndex := awsPreviewIntegrationIndex(operations, "lock-held:"+siteLockKey("sre"))
	registryIndex := awsPreviewIntegrationIndex(operations, "get:_indexes/sites.json")
	if lockIndex < 0 || registryIndex <= lockIndex {
		t.Fatalf("AWS operations = %v; want origin registry read after acquiring the site lock", operations)
	}
	for _, put := range client.putSnapshot() {
		if strings.HasPrefix(put.key, "_previews/sre/") {
			t.Fatalf("unregistered preview attempted storage write %q", put.key)
		}
	}
}

func TestAWSPreviewIntegrationRetriesInterruptedUploadWithoutCrossSiteWrites(t *testing.T) {
	root := createPreviewPublisherCheckout(t)
	client := newAWSPreviewIntegrationS3()
	awsPreviewIntegrationSeedRegistry(t, client, registeredSREManifest)
	client.seed("_previews/docs/catalog.json", Object{Bytes: []byte(`{"site":"docs","sentinel":"neighbor"}`)})
	client.seed("_previews/docs/revisions/neighbor/manifest.json", Object{Bytes: []byte(`{"head":"neighbor"}`)})
	docsLockBytes, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: "docs", State: "free"})
	if err != nil {
		t.Fatal(err)
	}
	client.seed(siteLockKey("docs"), Object{Bytes: docsLockBytes})
	neighborBefore := client.snapshotPrefix("_previews/docs/")
	docsLockBefore, docsLockETagBefore, ok := client.snapshot(siteLockKey("docs"))
	if !ok {
		t.Fatal("seeded neighboring docs site lock is missing")
	}

	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "preview-test"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	options := previewBuildOptions(root)
	expected, err := preview.BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit() = %v", err)
	}
	manifestKey, err := preview.ManifestKey(expected.Site, expected.Manifest.HeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	injectedFailure := errors.New("injected manifest upload interruption")
	client.failNextPut(providerObjectKey(manifestKey), injectedFailure)

	first, err := BuildAndPublishPreview(context.Background(), backend, options)
	if !errors.Is(err, injectedFailure) {
		t.Fatalf("first BuildAndPublishPreview() error = %v; want injected manifest upload interruption", err)
	}
	if first.Manifest.HeadSHA != expected.Manifest.HeadSHA {
		t.Fatalf("first result HEAD = %q, want %q", first.Manifest.HeadSHA, expected.Manifest.HeadSHA)
	}
	if _, _, exists := client.snapshot(providerObjectKey(manifestKey)); exists {
		t.Fatal("manifest exists after the injected interrupted upload")
	}
	catalogKey, err := preview.CatalogKey(expected.Site)
	if err != nil {
		t.Fatal(err)
	}
	if _, _, exists := client.snapshot(providerObjectKey(catalogKey)); exists {
		t.Fatal("catalog was written before the revision manifest completed")
	}

	completedBeforeRetry := make(map[string]awsPreviewIntegrationObject)
	for filePath, contents := range expected.Files {
		fileKey, keyErr := preview.FileKey(expected.Site, expected.Manifest.HeadSHA, filePath)
		if keyErr != nil {
			t.Fatal(keyErr)
		}
		objectKey := providerObjectKey(fileKey)
		object, _, exists := client.snapshot(objectKey)
		if !exists || !bytes.Equal(object.Bytes, contents) {
			t.Fatalf("completed file %q = %q (exists=%t), want %q after interrupted upload", fileKey, object.Bytes, exists, contents)
		}
		completedBeforeRetry[objectKey] = object
	}

	second, err := BuildAndPublishPreview(context.Background(), backend, options)
	if err != nil {
		t.Fatalf("retry BuildAndPublishPreview() error = %v", err)
	}
	if second.Outcome != preview.OutcomePublished || second.Manifest.HeadSHA != expected.Manifest.HeadSHA {
		t.Fatalf("retry result = %+v; want published same-head revision %q", second, expected.Manifest.HeadSHA)
	}
	for fileKey, before := range completedBeforeRetry {
		after, _, exists := client.snapshot(fileKey)
		if !exists || after.etag != before.etag || !bytes.Equal(after.Bytes, before.Bytes) {
			t.Errorf("completed immutable file %q after retry = %+v (exists=%t), want original ETag %q and bytes", fileKey, after, exists, before.etag)
		}
	}
	if _, _, exists := client.snapshot(providerObjectKey(manifestKey)); !exists {
		t.Fatal("manifest is missing after successful retry")
	}
	if _, _, exists := client.snapshot(providerObjectKey(catalogKey)); !exists {
		t.Fatal("catalog is missing after successful retry")
	}

	puts := client.putSnapshot()
	lockConditions := make([]awsPreviewIntegrationPut, 0)
	immutableConditions := make([]awsPreviewIntegrationPut, 0)
	for _, put := range puts {
		if put.key == siteLockKey("sre") {
			lockConditions = append(lockConditions, put)
		}
		if strings.HasPrefix(put.key, "_previews/sre/revisions/") {
			immutableConditions = append(immutableConditions, put)
		}
		if put.key != siteLockKey("sre") && !strings.HasPrefix(put.key, "_previews/sre/") {
			t.Errorf("SRE preview publication wrote outside its preview and lock scope: %q", put.key)
		}
	}
	if len(lockConditions) < 3 || lockConditions[0].ifNoneMatch != "*" {
		t.Fatalf("SRE site-lock conditions = %+v; want conditional initialization and compare-and-swap updates", lockConditions)
	}
	for _, condition := range lockConditions[1:] {
		if condition.ifMatch == "" || condition.ifNoneMatch != "" {
			t.Errorf("site-lock update condition = %+v; want If-Match only", condition)
		}
	}
	if len(immutableConditions) == 0 {
		t.Fatal("no AWS conditional immutable preview writes were recorded")
	}
	for _, condition := range immutableConditions {
		if condition.ifNoneMatch != "*" || condition.ifMatch != "" {
			t.Errorf("immutable preview write condition = %+v; want If-None-Match only", condition)
		}
	}

	if neighborAfter := client.snapshotPrefix("_previews/docs/"); !reflect.DeepEqual(neighborAfter, neighborBefore) {
		t.Errorf("neighboring docs preview prefix changed: before=%v after=%v", awsPreviewIntegrationKeys(neighborBefore), awsPreviewIntegrationKeys(neighborAfter))
	}
	docsLockAfter, docsLockETagAfter, ok := client.snapshot(siteLockKey("docs"))
	if !ok || docsLockETagAfter != docsLockETagBefore || !bytes.Equal(docsLockAfter.Bytes, docsLockBefore.Bytes) {
		t.Errorf("neighboring docs lock changed: before ETag %q, after ETag %q (exists=%t)", docsLockETagBefore, docsLockETagAfter, ok)
	}
}

func TestAWSPreviewIntegrationConcurrentGroupsKeepBothCatalogAndIsolateOtherSites(t *testing.T) {
	root := createPreviewPublisherCheckout(t)
	client := newAWSPreviewIntegrationS3()
	awsPreviewIntegrationSeedRegistry(t, client, registeredSREAndDocsManifest)
	seedAWSPreviewIntegrationNeighbor(t, client)
	neighborBefore := client.snapshotPrefix("_previews/docs/")
	neighborLockBefore, neighborLockETagBefore, ok := client.snapshot(siteLockKey("docs"))
	if !ok {
		t.Fatal("seeded neighboring docs site lock is missing")
	}

	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "preview-test"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	firstOptions, firstExpected := awsPreviewIntegrationPROptions(t, root, 42)
	secondOptions, secondExpected := awsPreviewIntegrationPROptions(t, root, 43)
	firstFileKey, err := preview.FileKey("sre", firstExpected.Manifest.HeadSHA, firstExpected.Manifest.Documents[0].Path)
	if err != nil {
		t.Fatal(err)
	}

	firstAtStorage := make(chan struct{})
	releaseFirst := make(chan struct{})
	secondObservedHeldLock := make(chan struct{}, 1)
	var releaseOnce sync.Once
	releaseFirstPublish := func() { releaseOnce.Do(func() { close(releaseFirst) }) }
	client.mu.Lock()
	client.afterPut = func(key string, _ awsPreviewIntegrationPut) {
		if key == providerObjectKey(firstFileKey) {
			close(firstAtStorage)
			<-releaseFirst
		}
	}
	client.afterGet = func(key string, object awsPreviewIntegrationObject) {
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
	client.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	defer releaseFirstPublish()
	type outcome struct {
		result preview.BuildResult
		err    error
	}
	firstDone := make(chan outcome, 1)
	go func() {
		result, publishErr := BuildAndPublishPreview(ctx, backend, firstOptions)
		firstDone <- outcome{result: result, err: publishErr}
	}()
	select {
	case <-firstAtStorage:
	case <-ctx.Done():
		t.Fatalf("first AWS preview publisher did not reach its immutable file write: %v", ctx.Err())
	}

	putsBeforeSecond := client.putSnapshot()
	secondDone := make(chan outcome, 1)
	go func() {
		result, publishErr := BuildAndPublishPreview(ctx, backend, secondOptions)
		secondDone <- outcome{result: result, err: publishErr}
	}()
	select {
	case <-secondObservedHeldLock:
	case <-ctx.Done():
		t.Fatalf("second AWS preview publisher did not observe the held site lock: %v", ctx.Err())
	}
	select {
	case result := <-firstDone:
		t.Fatalf("first AWS preview publisher passed its storage barrier: %+v", result)
	default:
	}
	select {
	case result := <-secondDone:
		t.Fatalf("second AWS preview publisher completed while the first held the lock: %+v", result)
	default:
	}
	if putsAfterSecond := client.putSnapshot(); len(putsAfterSecond) != len(putsBeforeSecond) {
		t.Fatalf("second publisher made S3 writes while waiting for the SRE lock: before=%+v after=%+v", putsBeforeSecond, putsAfterSecond)
	}

	releaseFirstPublish()
	for name, done := range map[string]<-chan outcome{"first": firstDone, "second": secondDone} {
		select {
		case result := <-done:
			if result.err != nil || result.result.Outcome != preview.OutcomePublished {
				t.Errorf("%s AWS preview publish = %+v, err=%v; want published", name, result.result, result.err)
			}
		case <-ctx.Done():
			t.Errorf("%s AWS preview publisher did not finish after lock release: %v", name, ctx.Err())
		}
	}

	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}
	catalogObject, _, ok := client.snapshot(providerObjectKey(catalogKey))
	if !ok {
		t.Fatal("SRE preview catalog is missing after concurrent AWS publication")
	}
	catalog, err := preview.DecodeCatalog(catalogObject.Bytes)
	if err != nil {
		t.Fatalf("decode SRE preview catalog: %v", err)
	}
	gotGroups := make(map[string]string, len(catalog.Groups))
	for _, group := range catalog.Groups {
		gotGroups[group.ID] = group.HeadSHA
	}
	if len(gotGroups) != 2 || gotGroups[firstExpected.Group.ID] != firstExpected.Manifest.HeadSHA || gotGroups[secondExpected.Group.ID] != secondExpected.Manifest.HeadSHA {
		t.Fatalf("concurrent SRE catalog groups = %+v; want %s and %s", catalog.Groups, firstExpected.Group.ID, secondExpected.Group.ID)
	}
	for _, expected := range []preview.BuildResult{firstExpected, secondExpected} {
		manifestKey, keyErr := preview.ManifestKey(expected.Site, expected.Manifest.HeadSHA)
		if keyErr != nil {
			t.Fatal(keyErr)
		}
		if _, _, exists := client.snapshot(providerObjectKey(manifestKey)); !exists {
			t.Errorf("revision manifest %q is missing", manifestKey)
		}
		for relativePath, want := range expected.Files {
			fileKey, keyErr := preview.FileKey(expected.Site, expected.Manifest.HeadSHA, relativePath)
			if keyErr != nil {
				t.Fatal(keyErr)
			}
			stored, _, exists := client.snapshot(providerObjectKey(fileKey))
			if !exists || !bytes.Equal(stored.Bytes, want) {
				t.Errorf("revision file %q = %q (exists=%t), want %q", fileKey, stored.Bytes, exists, want)
			}
		}
	}
	assertAWSPreviewIntegrationWritesStayInSite(t, client.putSnapshot(), "sre")
	if after := client.snapshotPrefix("_previews/docs/"); !reflect.DeepEqual(after, neighborBefore) {
		t.Errorf("neighboring docs preview prefix changed: before=%v after=%v", awsPreviewIntegrationKeys(neighborBefore), awsPreviewIntegrationKeys(after))
	}
	neighborLockAfter, neighborLockETagAfter, ok := client.snapshot(siteLockKey("docs"))
	if !ok || neighborLockETagAfter != neighborLockETagBefore || !bytes.Equal(neighborLockAfter.Bytes, neighborLockBefore.Bytes) {
		t.Errorf("neighboring docs lock changed: before ETag %q, after ETag %q (exists=%t)", neighborLockETagBefore, neighborLockETagAfter, ok)
	}
}

func TestAWSPreviewIntegrationRejectsCatalogWriteAfterLockLossWithoutCrossSiteWrites(t *testing.T) {
	root := createPreviewPublisherCheckout(t)
	client := newAWSPreviewIntegrationS3()
	awsPreviewIntegrationSeedRegistry(t, client, registeredSREAndDocsManifest)
	seedAWSPreviewIntegrationNeighbor(t, client)
	neighborBefore := client.snapshotPrefix("_previews/docs/")
	neighborLockBefore, neighborLockETagBefore, ok := client.snapshot(siteLockKey("docs"))
	if !ok {
		t.Fatal("seeded neighboring docs site lock is missing")
	}

	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "preview-test"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	options, expected := awsPreviewIntegrationPROptions(t, root, 42)
	manifestKey, err := preview.ManifestKey(expected.Site, expected.Manifest.HeadSHA)
	if err != nil {
		t.Fatal(err)
	}
	var lockMutationErr error
	var lockWasReplaced bool
	client.mu.Lock()
	client.afterPut = func(key string, _ awsPreviewIntegrationPut) {
		if key != providerObjectKey(manifestKey) || lockWasReplaced {
			return
		}
		lockMutationErr = client.replaceSiteLockWithFreeRecord("sre")
		lockWasReplaced = lockMutationErr == nil
	}
	client.mu.Unlock()

	result, err := BuildAndPublishPreview(context.Background(), backend, options)
	if !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("BuildAndPublishPreview() after lock loss = %+v, %v; want ErrPreconditionFailed", result, err)
	}
	if !lockWasReplaced {
		t.Fatalf("test did not replace the held AWS site lock: %v", lockMutationErr)
	}
	catalogKey, err := preview.CatalogKey("sre")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, exists := client.snapshot(providerObjectKey(catalogKey)); exists {
		t.Fatal("SRE catalog was written after the site lock was replaced")
	}
	if _, _, exists := client.snapshot(providerObjectKey(manifestKey)); !exists {
		t.Fatal("completed immutable SRE manifest is missing after lock loss")
	}
	puts := client.putSnapshot()
	assertAWSPreviewIntegrationWritesStayInSite(t, puts, "sre")
	for _, put := range puts {
		if put.key == providerObjectKey(catalogKey) {
			t.Fatal("catalog replacement reached AWS after the site lock was lost")
		}
	}
	if after := client.snapshotPrefix("_previews/docs/"); !reflect.DeepEqual(after, neighborBefore) {
		t.Errorf("neighboring docs preview prefix changed after SRE lock loss: before=%v after=%v", awsPreviewIntegrationKeys(neighborBefore), awsPreviewIntegrationKeys(after))
	}
	neighborLockAfter, neighborLockETagAfter, ok := client.snapshot(siteLockKey("docs"))
	if !ok || neighborLockETagAfter != neighborLockETagBefore || !bytes.Equal(neighborLockAfter.Bytes, neighborLockBefore.Bytes) {
		t.Errorf("neighboring docs lock changed: before ETag %q, after ETag %q (exists=%t)", neighborLockETagBefore, neighborLockETagAfter, ok)
	}
}

func awsPreviewIntegrationPROptions(t *testing.T, root string, number int) (preview.BuildOptions, preview.BuildResult) {
	t.Helper()
	options := previewBuildOptions(root)
	base, err := preview.BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit() for PR %d head: %v", number, err)
	}
	options.Repository = "acme/sre"
	options.PullRequestURL = fmt.Sprintf("https://github.com/acme/sre/pull/%d", number)
	options.PullRequestHeadRepository = "acme/sre"
	options.PullRequestHeadSHA = base.Manifest.HeadSHA
	expected, err := preview.BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit() for PR %d preview: %v", number, err)
	}
	return options, expected
}

func seedAWSPreviewIntegrationNeighbor(t *testing.T, client *awsPreviewIntegrationS3) {
	t.Helper()
	client.seed("_previews/docs/catalog.json", Object{Bytes: []byte(`{"site":"docs","sentinel":"neighbor"}`)})
	client.seed("_previews/docs/revisions/neighbor/manifest.json", Object{Bytes: []byte(`{"head":"neighbor"}`)})
	docsLockBytes, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: "docs", State: "free"})
	if err != nil {
		t.Fatal(err)
	}
	client.seed(siteLockKey("docs"), Object{Bytes: docsLockBytes})
}

func assertAWSPreviewIntegrationWritesStayInSite(t *testing.T, puts []awsPreviewIntegrationPut, site string) {
	t.Helper()
	lockKey := siteLockKey(site)
	previewPrefix := "_previews/" + site + "/"
	for _, put := range puts {
		if put.key != lockKey && !strings.HasPrefix(put.key, previewPrefix) {
			t.Errorf("%s preview publication wrote outside its preview and lock scope: %q", site, put.key)
		}
	}
}

type awsPreviewIntegrationObject struct {
	Object
	etag string
}

type awsPreviewIntegrationPut struct {
	key         string
	ifNoneMatch string
	ifMatch     string
}

type awsPreviewIntegrationS3 struct {
	mu         sync.Mutex
	objects    map[string]awsPreviewIntegrationObject
	nextETag   int
	pageSize   int
	operations []string
	puts       []awsPreviewIntegrationPut
	failures   map[string][]error
	afterPut   func(string, awsPreviewIntegrationPut)
	afterGet   func(string, awsPreviewIntegrationObject)
}

func newAWSPreviewIntegrationS3() *awsPreviewIntegrationS3 {
	return &awsPreviewIntegrationS3{
		objects:  make(map[string]awsPreviewIntegrationObject),
		pageSize: 1000,
		failures: make(map[string][]error),
	}
}

func (client *awsPreviewIntegrationS3) seed(key string, object Object) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.nextETag++
	client.objects[key] = awsPreviewIntegrationObject{Object: awsPreviewIntegrationCloneObject(object), etag: fmt.Sprintf(`"aws-preview-seed-%d"`, client.nextETag)}
}

func (client *awsPreviewIntegrationS3) failNextPut(key string, err error) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.failures[key] = append(client.failures[key], err)
}

func (client *awsPreviewIntegrationS3) replaceSiteLockWithFreeRecord(site string) error {
	key := siteLockKey(site)
	contents, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: site, State: "free"})
	if err != nil {
		return err
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if _, exists := client.objects[key]; !exists {
		return fmt.Errorf("site lock %q is missing", site)
	}
	client.nextETag++
	client.objects[key] = awsPreviewIntegrationObject{
		Object: Object{Bytes: contents, ContentType: "application/json; charset=utf-8"},
		etag:   fmt.Sprintf(`"aws-preview-recovered-%d"`, client.nextETag),
	}
	client.operations = append(client.operations, "external-lock-recovery:"+key)
	return nil
}

func (client *awsPreviewIntegrationS3) PutObject(ctx context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	contents, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	put := awsPreviewIntegrationPut{key: key, ifNoneMatch: aws.ToString(input.IfNoneMatch), ifMatch: aws.ToString(input.IfMatch)}
	client.mu.Lock()
	client.operations = append(client.operations, "put:"+key)
	client.puts = append(client.puts, put)
	if failures := client.failures[key]; len(failures) > 0 {
		client.failures[key] = failures[1:]
		client.mu.Unlock()
		return nil, failures[0]
	}
	current, exists := client.objects[key]
	if put.ifNoneMatch == "*" && exists || put.ifMatch != "" && (!exists || put.ifMatch != current.etag) {
		client.mu.Unlock()
		return nil, awsPreviewIntegrationS3Error(http.StatusPreconditionFailed, "PreconditionFailed")
	}
	client.nextETag++
	etag := fmt.Sprintf(`"aws-preview-%d"`, client.nextETag)
	object := Object{
		Bytes:              append([]byte(nil), contents...),
		ContentType:        aws.ToString(input.ContentType),
		ContentDisposition: aws.ToString(input.ContentDisposition),
		ContentEncoding:    aws.ToString(input.ContentEncoding),
		Cache:              aws.ToString(input.CacheControl),
		Metadata:           awsPreviewIntegrationCloneMetadata(input.Metadata),
	}
	client.objects[key] = awsPreviewIntegrationObject{Object: object, etag: etag}
	if strings.HasPrefix(key, siteControlRoot) && strings.HasSuffix(key, "/lock.json") {
		var record lockRecord
		if json.Unmarshal(contents, &record) == nil && record.State == "held" {
			client.operations = append(client.operations, "lock-held:"+key)
		}
	}
	afterPut := client.afterPut
	client.mu.Unlock()
	if afterPut != nil {
		afterPut(key, put)
	}
	return &s3.PutObjectOutput{ETag: aws.String(etag)}, nil
}

func (client *awsPreviewIntegrationS3) GetObject(ctx context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	client.mu.Lock()
	client.operations = append(client.operations, "get:"+key)
	object, exists := client.objects[key]
	if !exists {
		client.mu.Unlock()
		return nil, awsPreviewIntegrationS3Error(http.StatusNotFound, "NoSuchKey")
	}
	if key == siteLockKey("sre") {
		var record lockRecord
		if json.Unmarshal(object.Bytes, &record) == nil && record.State == "held" {
			client.operations = append(client.operations, "lock-held-read:"+key)
		}
	}
	output := &s3.GetObjectOutput{
		Body: io.NopCloser(bytes.NewReader(object.Bytes)), ETag: aws.String(object.etag),
		ContentType: aws.String(object.ContentType), CacheControl: aws.String(object.Cache), Metadata: awsPreviewIntegrationCloneMetadata(object.Metadata),
	}
	afterGet := client.afterGet
	object.Object = awsPreviewIntegrationCloneObject(object.Object)
	client.mu.Unlock()
	if afterGet != nil {
		afterGet(key, object)
	}
	return output, nil
}

func (client *awsPreviewIntegrationS3) HeadObject(ctx context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	client.mu.Lock()
	defer client.mu.Unlock()
	client.operations = append(client.operations, "head:"+key)
	object, exists := client.objects[key]
	if !exists {
		return nil, awsPreviewIntegrationS3Error(http.StatusNotFound, "NoSuchKey")
	}
	return &s3.HeadObjectOutput{
		ETag: aws.String(object.etag), ContentLength: aws.Int64(int64(len(object.Bytes))),
		ContentType: aws.String(object.ContentType), ContentDisposition: aws.String(object.ContentDisposition),
		ContentEncoding: aws.String(object.ContentEncoding), CacheControl: aws.String(object.Cache),
		Metadata: awsPreviewIntegrationCloneMetadata(object.Metadata),
	}, nil
}

func (client *awsPreviewIntegrationS3) ListObjectsV2(ctx context.Context, input *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	prefix := aws.ToString(input.Prefix)
	client.mu.Lock()
	defer client.mu.Unlock()
	client.operations = append(client.operations, "list:"+prefix)
	keys := make([]string, 0)
	for key := range client.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	start := 0
	if input.ContinuationToken != nil {
		if _, scanErr := fmt.Sscanf(aws.ToString(input.ContinuationToken), "%d", &start); scanErr != nil || start < 0 || start > len(keys) {
			return nil, fmt.Errorf("invalid AWS preview fake continuation token %q", aws.ToString(input.ContinuationToken))
		}
	}
	pageSize := client.pageSize
	if input.MaxKeys != nil && int(aws.ToInt32(input.MaxKeys)) > 0 && int(aws.ToInt32(input.MaxKeys)) < pageSize {
		pageSize = int(aws.ToInt32(input.MaxKeys))
	}
	end := min(start+pageSize, len(keys))
	contents := make([]types.Object, 0, end-start)
	for _, key := range keys[start:end] {
		contents = append(contents, types.Object{Key: aws.String(key)})
	}
	result := &s3.ListObjectsV2Output{Contents: contents, IsTruncated: aws.Bool(end < len(keys))}
	if end < len(keys) {
		result.NextContinuationToken = aws.String(fmt.Sprintf("%d", end))
	}
	return result, nil
}

func (client *awsPreviewIntegrationS3) DeleteObjects(ctx context.Context, input *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if input.Delete == nil {
		return nil, errors.New("AWS preview fake received empty delete request")
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	client.operations = append(client.operations, "delete")
	for _, object := range input.Delete.Objects {
		delete(client.objects, aws.ToString(object.Key))
	}
	return &s3.DeleteObjectsOutput{}, nil
}

func (client *awsPreviewIntegrationS3) snapshot(key string) (awsPreviewIntegrationObject, string, bool) {
	client.mu.Lock()
	defer client.mu.Unlock()
	object, exists := client.objects[key]
	if !exists {
		return awsPreviewIntegrationObject{}, "", false
	}
	object.Object = awsPreviewIntegrationCloneObject(object.Object)
	return object, object.etag, true
}

func (client *awsPreviewIntegrationS3) snapshotPrefix(prefix string) map[string]awsPreviewIntegrationObject {
	client.mu.Lock()
	defer client.mu.Unlock()
	result := make(map[string]awsPreviewIntegrationObject)
	for key, object := range client.objects {
		if strings.HasPrefix(key, prefix) {
			object.Object = awsPreviewIntegrationCloneObject(object.Object)
			result[key] = object
		}
	}
	return result
}

func (client *awsPreviewIntegrationS3) operationSnapshot() []string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return append([]string(nil), client.operations...)
}

func (client *awsPreviewIntegrationS3) putSnapshot() []awsPreviewIntegrationPut {
	client.mu.Lock()
	defer client.mu.Unlock()
	return append([]awsPreviewIntegrationPut(nil), client.puts...)
}

func awsPreviewIntegrationSeedRegistry(t *testing.T, client *awsPreviewIntegrationS3, manifest string) {
	t.Helper()
	contents, _, err := testRegistryBuild(t, []byte(manifest))
	if err != nil {
		t.Fatalf("build AWS preview registry fixture: %v", err)
	}
	client.seed("_indexes/sites.json", Object{Bytes: contents, ContentType: "application/json; charset=utf-8"})
}

func awsPreviewIntegrationIndex(operations []string, target string) int {
	for index, operation := range operations {
		if operation == target {
			return index
		}
	}
	return -1
}

func awsPreviewIntegrationKeys(objects map[string]awsPreviewIntegrationObject) []string {
	keys := make([]string, 0, len(objects))
	for key := range objects {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func awsPreviewIntegrationCloneObject(object Object) Object {
	object.Bytes = append([]byte(nil), object.Bytes...)
	object.Metadata = awsPreviewIntegrationCloneMetadata(object.Metadata)
	return object
}

func awsPreviewIntegrationCloneMetadata(metadata map[string]string) map[string]string {
	if metadata == nil {
		return nil
	}
	result := make(map[string]string, len(metadata))
	for key, value := range metadata {
		result[key] = value
	}
	return result
}

func awsPreviewIntegrationS3Error(status int, code string) error {
	return &smithyhttp.ResponseError{
		Response: &smithyhttp.Response{Response: &http.Response{StatusCode: status}},
		Err:      &smithy.GenericAPIError{Code: code, Message: "deterministic AWS preview fake response", Fault: smithy.FaultClient},
	}
}
