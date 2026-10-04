package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	cloudfronttypes "github.com/aws/aws-sdk-go-v2/service/cloudfront/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type sitePublishV2CostStoredObject struct {
	object Object
	etag   string
}

// sitePublishV2CostS3 counts the real S3-compatible adapter requests by key
// category while storing objects in memory. The publisher, AWS/R2 adapters,
// CAS conditions, and cache paths remain the production implementations.
type sitePublishV2CostS3 struct {
	mu sync.Mutex

	objects   map[string]sitePublishV2CostStoredObject
	nextETag  int
	requests  map[string]int
	readByte  map[string]int64
	writeByte map[string]int64
	events    []string
}

func newSitePublishV2CostS3() *sitePublishV2CostS3 {
	return &sitePublishV2CostS3{
		objects: make(map[string]sitePublishV2CostStoredObject), requests: make(map[string]int),
		readByte: make(map[string]int64), writeByte: make(map[string]int64),
	}
}

func (client *sitePublishV2CostS3) seed(key string, object Object) {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.objects[key] = sitePublishV2CostStoredObject{object: sitePublishV2CostCloneObject(object), etag: `"seed-` + key + `"`}
}

func (client *sitePublishV2CostS3) copyPersistentObjectsFrom(source *sitePublishV2CostS3) {
	source.mu.Lock()
	defer source.mu.Unlock()
	client.mu.Lock()
	defer client.mu.Unlock()
	client.objects = make(map[string]sitePublishV2CostStoredObject, len(source.objects))
	for key, stored := range source.objects {
		client.objects[key] = sitePublishV2CostStoredObject{
			object: sitePublishV2CostCloneObject(stored.object), etag: stored.etag,
		}
	}
	client.nextETag = source.nextETag
}

func (client *sitePublishV2CostS3) resetCounts() {
	client.mu.Lock()
	defer client.mu.Unlock()
	client.requests = make(map[string]int)
	client.readByte = make(map[string]int64)
	client.writeByte = make(map[string]int64)
	client.events = nil
}

func (client *sitePublishV2CostS3) recordLocked(operation, key string, readBytes, writtenBytes int64) {
	category := sitePublishV2CostCategory(key)
	client.requests[operation+"."+category]++
	client.requests[operation+".total"]++
	client.readByte[category] += readBytes
	client.writeByte[category] += writtenBytes
	client.events = append(client.events, operation+"."+category)
}

func (client *sitePublishV2CostS3) recordDeleteLocked(keys []string) {
	client.requests["DELETE.total"]++
	categories := make(map[string]struct{})
	for _, key := range keys {
		categories[sitePublishV2CostCategory(key)] = struct{}{}
	}
	for category := range categories {
		client.requests["DELETE."+category]++
		client.events = append(client.events, "DELETE."+category)
	}
}

func (client *sitePublishV2CostS3) PutObject(ctx context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var body []byte
	if input.Body != nil {
		contents, err := io.ReadAll(input.Body)
		if err != nil {
			return nil, err
		}
		body = contents
	}
	object := Object{
		Bytes: body, ContentType: aws.ToString(input.ContentType), ContentDisposition: aws.ToString(input.ContentDisposition),
		ContentEncoding: aws.ToString(input.ContentEncoding), Cache: aws.ToString(input.CacheControl),
		Metadata: sitePublishV2CostCloneMetadata(input.Metadata),
	}
	etag, err := client.put(aws.ToString(input.Key), object, aws.ToString(input.IfMatch), aws.ToString(input.IfNoneMatch))
	if err != nil {
		return nil, err
	}
	return &s3.PutObjectOutput{ETag: aws.String(etag)}, nil
}

func (client *sitePublishV2CostS3) put(key string, object Object, ifMatch, ifNoneMatch string) (string, error) {
	client.mu.Lock()
	client.recordLocked("PUT", key, 0, int64(len(object.Bytes)))
	current, exists := client.objects[key]
	if ifNoneMatch == "*" && exists || ifMatch != "" && (!exists || current.etag != ifMatch) {
		client.mu.Unlock()
		return "", s3ResponseError(http.StatusPreconditionFailed, "PreconditionFailed")
	}
	client.nextETag++
	etag := fmt.Sprintf(`"cost-%08d"`, client.nextETag)
	client.objects[key] = sitePublishV2CostStoredObject{object: sitePublishV2CostCloneObject(object), etag: etag}
	client.mu.Unlock()
	return etag, nil
}

func (client *sitePublishV2CostS3) GetObject(ctx context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	client.mu.Lock()
	stored, exists := client.objects[key]
	var size int64
	if exists {
		size = int64(len(stored.object.Bytes))
	}
	client.recordLocked("GET", key, size, 0)
	client.mu.Unlock()
	if !exists {
		return nil, s3ResponseError(http.StatusNotFound, "NoSuchKey")
	}
	object := sitePublishV2CostCloneObject(stored.object)
	return &s3.GetObjectOutput{
		Body: io.NopCloser(bytes.NewReader(object.Bytes)), ETag: aws.String(stored.etag), ContentLength: aws.Int64(int64(len(object.Bytes))),
		ContentType: aws.String(object.ContentType), ContentDisposition: aws.String(object.ContentDisposition),
		ContentEncoding: aws.String(object.ContentEncoding), CacheControl: aws.String(object.Cache), Metadata: object.Metadata,
	}, nil
}

func (client *sitePublishV2CostS3) HeadObject(ctx context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	client.mu.Lock()
	stored, exists := client.objects[key]
	client.recordLocked("HEAD", key, 0, 0)
	client.mu.Unlock()
	if !exists {
		return nil, s3ResponseError(http.StatusNotFound, "NoSuchKey")
	}
	object := stored.object
	return &s3.HeadObjectOutput{
		ETag: aws.String(stored.etag), ContentLength: aws.Int64(int64(len(object.Bytes))),
		ContentType: aws.String(object.ContentType), ContentDisposition: aws.String(object.ContentDisposition),
		ContentEncoding: aws.String(object.ContentEncoding), CacheControl: aws.String(object.Cache),
		Metadata: sitePublishV2CostCloneMetadata(object.Metadata),
	}, nil
}

func (client *sitePublishV2CostS3) ListObjectsV2(ctx context.Context, input *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	prefix := aws.ToString(input.Prefix)
	client.mu.Lock()
	client.recordLocked("LIST", prefix, 0, 0)
	keys := make([]string, 0)
	for key := range client.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	client.mu.Unlock()
	sort.Strings(keys)
	contents := make([]types.Object, 0, len(keys))
	for _, key := range keys {
		contents = append(contents, types.Object{Key: aws.String(key)})
	}
	return &s3.ListObjectsV2Output{Contents: contents, IsTruncated: aws.Bool(false), KeyCount: aws.Int32(int32(len(contents)))}, nil
}

func (client *sitePublishV2CostS3) DeleteObjects(ctx context.Context, input *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	keys := make([]string, 0)
	if input.Delete != nil {
		for _, object := range input.Delete.Objects {
			keys = append(keys, aws.ToString(object.Key))
		}
	}
	client.mu.Lock()
	client.recordDeleteLocked(keys)
	for _, key := range keys {
		delete(client.objects, key)
	}
	client.mu.Unlock()
	return &s3.DeleteObjectsOutput{}, nil
}

func (client *sitePublishV2CostS3) snapshot() sitePublishV2CostSnapshot {
	client.mu.Lock()
	defer client.mu.Unlock()
	result := sitePublishV2CostSnapshot{
		Requests: make(map[string]int, len(client.requests)), ReadBytes: make(map[string]int64, len(client.readByte)),
		WriteBytes: make(map[string]int64, len(client.writeByte)), Events: append([]string(nil), client.events...),
	}
	for key, value := range client.requests {
		result.Requests[key] = value
	}
	for key, value := range client.readByte {
		result.ReadBytes[key] = value
	}
	for key, value := range client.writeByte {
		result.WriteBytes[key] = value
	}
	return result
}

func sitePublishV2CostCategory(key string) string {
	switch {
	case key == sitePublishStateKey("sre"):
		return "state"
	case key == siteCacheRetryKey("sre"):
		return "journal"
	case strings.HasPrefix(key, "_control/locks/"):
		return "lock"
	case key == "_indexes/sites.json":
		return "registry"
	case strings.HasPrefix(key, "_previews/sre/"):
		return "preview"
	case strings.HasPrefix(key, "_artifacts/sre/") || strings.HasPrefix(key, "_indexes/sre/"):
		return "projection"
	default:
		return "other"
	}
}

func sitePublishV2CostCloneObject(object Object) Object {
	object.Bytes = append([]byte(nil), object.Bytes...)
	object.Metadata = sitePublishV2CostCloneMetadata(object.Metadata)
	return object
}

func sitePublishV2CostCloneMetadata(metadata map[string]string) map[string]string {
	if metadata == nil {
		return nil
	}
	clone := make(map[string]string, len(metadata))
	for key, value := range metadata {
		clone[key] = value
	}
	return clone
}

type sitePublishV2CostSnapshot struct {
	Requests   map[string]int
	ReadBytes  map[string]int64
	WriteBytes map[string]int64
	Events     []string
}

type sitePublishV2CostReport struct {
	Provider                string         `json:"provider"`
	Scenario                string         `json:"scenario"`
	ObjectRequests          map[string]int `json:"objectRequests"`
	ClassA                  int            `json:"classA"`
	ClassB                  int            `json:"classB"`
	DeleteRequests          int            `json:"deleteRequests"`
	ControlRequests         int            `json:"controlRequests"`
	ControlClassA           int            `json:"controlClassA"`
	ControlClassB           int            `json:"controlClassB"`
	ProjectionRequests      int            `json:"projectionRequests"`
	StateBodyReadBytes      int64          `json:"stateBodyReadBytes"`
	StateBodyWrittenBytes   int64          `json:"stateBodyWrittenBytes"`
	JournalBodyReadBytes    int64          `json:"journalBodyReadBytes"`
	JournalBodyWrittenBytes int64          `json:"journalBodyWrittenBytes"`
	LockBodyWrittenBytes    int64          `json:"lockBodyWrittenBytes"`
	ProjectionBodyWritten   int64          `json:"projectionBodyWrittenBytes"`
	CDNInvalidationRequests int            `json:"cdnInvalidationRequests"`
	Events                  []string       `json:"events"`
}

func sitePublishV2CostMakeReport(provider, scenario string, snapshot sitePublishV2CostSnapshot, cdnCalls int) sitePublishV2CostReport {
	report := sitePublishV2CostReport{
		Provider: provider, Scenario: scenario, ObjectRequests: snapshot.Requests,
		StateBodyReadBytes: snapshot.ReadBytes["state"], StateBodyWrittenBytes: snapshot.WriteBytes["state"],
		JournalBodyReadBytes: snapshot.ReadBytes["journal"], JournalBodyWrittenBytes: snapshot.WriteBytes["journal"],
		LockBodyWrittenBytes: snapshot.WriteBytes["lock"], ProjectionBodyWritten: snapshot.WriteBytes["projection"],
		CDNInvalidationRequests: cdnCalls, Events: snapshot.Events,
	}
	for request, count := range snapshot.Requests {
		parts := strings.SplitN(request, ".", 2)
		if len(parts) != 2 || parts[1] == "total" {
			continue
		}
		operation, category := parts[0], parts[1]
		if operation == "PUT" || operation == "LIST" {
			report.ClassA += count
			if category != "projection" {
				report.ControlClassA += count
			}
		}
		if operation == "GET" || operation == "HEAD" {
			report.ClassB += count
			if category != "projection" {
				report.ControlClassB += count
			}
		}
		if operation == "DELETE" {
			report.DeleteRequests += count
		}
		if category == "projection" {
			report.ProjectionRequests += count
		} else {
			report.ControlRequests += count
		}
	}
	return report
}

func sitePublishV2CostLogReport(t *testing.T, report sitePublishV2CostReport) {
	t.Helper()
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("encode cost report: %v", err)
	}
	t.Log(string(data))
}

func TestPublishSiteWholeControlRequestsCompareR2GetOnlyAndAWSHeadThenGet(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	resourcePath := filepath.Join(root, "docs", "artifacts", "assets", "theme.css")
	if err := os.MkdirAll(filepath.Dir(resourcePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resourcePath, []byte("body { color: navy; }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	ctx := context.Background()

	r2Store := newSitePublishV2CostS3()
	awsStore := newSitePublishV2CostS3()
	registryBytes, _, err := testRegistryBuild(t, []byte(registeredSREManifest))
	if err != nil {
		t.Fatal(err)
	}
	registryObject := Object{Bytes: registryBytes, ContentType: "application/json; charset=utf-8", Cache: indexCacheControl}
	r2Store.seed("_indexes/sites.json", registryObject)
	awsStore.seed("_indexes/sites.json", registryObject)

	r2Backend, r2CDN := sitePublishV2CostCloudflare(t, r2Store)
	awsCDN := &sitePublishV2CostCloudFront{}
	awsBackend, err := newAWSBackend(awsClients{s3: awsStore, cloudFront: awsCDN}, AWSOptions{Bucket: "cost-test", DistributionID: "E123COST"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	if got := selectedPublishStateReadMode(r2Backend); got != publishStateReadGetOnly {
		t.Fatalf("Cloudflare read mode = %v, want GET-only", got)
	}
	if got := selectedPublishStateReadMode(awsBackend); got != publishStateReadHeadThenGet {
		t.Fatalf("AWS read mode = %v, want HEAD-then-GET", got)
	}

	result, err := PublishSite(ctx, r2Backend, options)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("initial R2 PublishSite() = %+v, err=%v", result, err)
	}
	// Start both measured paths from the exact same committed state and origin
	// projection so only the selected private-state read mode varies.
	awsStore.copyPersistentObjectsFrom(r2Store)

	// A HEAD-first AWS no-op uses one metadata request. R2's selected GET-only
	// mode uses one Class B request too, but reads the state body.
	r2Store.resetCounts()
	awsStore.resetCounts()
	r2CDN.reset()
	awsCDN.reset()
	r2NoOp, err := PublishSite(ctx, r2Backend, options)
	if err != nil || r2NoOp.Outcome != "no-op" || !r2NoOp.BuildSkipped {
		t.Fatalf("R2 no-op = %+v, err=%v", r2NoOp, err)
	}
	awsNoOp, err := PublishSite(ctx, awsBackend, options)
	if err != nil || awsNoOp.Outcome != "no-op" || !awsNoOp.BuildSkipped {
		t.Fatalf("AWS no-op = %+v, err=%v", awsNoOp, err)
	}
	r2NoOpReport := sitePublishV2CostMakeReport("R2", "no-op", r2Store.snapshot(), r2CDN.calls())
	awsNoOpReport := sitePublishV2CostMakeReport("AWS", "no-op", awsStore.snapshot(), awsCDN.calls())
	sitePublishV2CostLogReport(t, r2NoOpReport)
	sitePublishV2CostLogReport(t, awsNoOpReport)
	if r2NoOpReport.ObjectRequests["GET.state"] != 1 || r2NoOpReport.ObjectRequests["HEAD.state"] != 0 || r2NoOpReport.ObjectRequests["PUT.state"] != 0 {
		t.Fatalf("R2 no-op state requests = %v; want GET=1 HEAD=0 PUT=0", r2NoOpReport.ObjectRequests)
	}
	if awsNoOpReport.ObjectRequests["HEAD.state"] != 1 || awsNoOpReport.ObjectRequests["GET.state"] != 0 || awsNoOpReport.ObjectRequests["PUT.state"] != 0 {
		t.Fatalf("AWS no-op state requests = %v; want HEAD=1 GET=0 PUT=0", awsNoOpReport.ObjectRequests)
	}
	if r2NoOpReport.ClassB != awsNoOpReport.ClassB || r2NoOpReport.StateBodyReadBytes <= 0 || awsNoOpReport.StateBodyReadBytes != 0 {
		t.Fatalf("no-op Class B/state body bytes R2=%d/%d AWS=%d/%d; want equal Class B and GET-only body read", r2NoOpReport.ClassB, r2NoOpReport.StateBodyReadBytes, awsNoOpReport.ClassB, awsNoOpReport.StateBodyReadBytes)
	}
	if r2NoOpReport.CDNInvalidationRequests != 0 || awsNoOpReport.CDNInvalidationRequests != 0 {
		t.Fatalf("no-op CDN requests R2/AWS = %d/%d; want none", r2NoOpReport.CDNInvalidationRequests, awsNoOpReport.CDNInvalidationRequests)
	}
	if err := sitePublishV2CostRequireSameNonStateRequests(r2NoOpReport.ObjectRequests, awsNoOpReport.ObjectRequests); err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(resourcePath, []byte("body { color: firebrick; }\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	r2Store.resetCounts()
	awsStore.resetCounts()
	r2CDN.reset()
	awsCDN.reset()
	r2Changed, err := PublishSite(ctx, r2Backend, options)
	if err != nil || r2Changed.Outcome != "published" {
		t.Fatalf("R2 changed-resource publish = %+v, err=%v", r2Changed, err)
	}
	awsChanged, err := PublishSite(ctx, awsBackend, options)
	if err != nil || awsChanged.Outcome != "published" {
		t.Fatalf("AWS changed-resource publish = %+v, err=%v", awsChanged, err)
	}
	r2ChangedSnapshot, awsChangedSnapshot := r2Store.snapshot(), awsStore.snapshot()
	r2ChangedReport := sitePublishV2CostMakeReport("R2", "one changed resource", r2ChangedSnapshot, r2CDN.calls())
	awsChangedReport := sitePublishV2CostMakeReport("AWS", "one changed resource", awsChangedSnapshot, awsCDN.calls())
	sitePublishV2CostLogReport(t, r2ChangedReport)
	sitePublishV2CostLogReport(t, awsChangedReport)
	if r2ChangedReport.ObjectRequests["GET.state"] != 1 || r2ChangedReport.ObjectRequests["HEAD.state"] != 0 || r2ChangedReport.ObjectRequests["PUT.state"] != 1 {
		t.Fatalf("R2 changed state requests = %v; want GET=1 HEAD=0 and one final state PUT", r2ChangedReport.ObjectRequests)
	}
	if awsChangedReport.ObjectRequests["HEAD.state"] != 1 || awsChangedReport.ObjectRequests["GET.state"] != 1 || awsChangedReport.ObjectRequests["PUT.state"] != 1 {
		t.Fatalf("AWS changed state requests = %v; want HEAD=1 GET=1 and one final state PUT", awsChangedReport.ObjectRequests)
	}
	if awsChangedReport.ControlClassB != r2ChangedReport.ControlClassB+1 {
		t.Fatalf("changed control Class B R2/AWS = %d/%d; want one fewer R2 state/control request", r2ChangedReport.ControlClassB, awsChangedReport.ControlClassB)
	}
	if r2ChangedReport.ClassA != awsChangedReport.ClassA || r2ChangedReport.DeleteRequests != awsChangedReport.DeleteRequests {
		t.Fatalf("changed Class A/deletes R2=%d/%d AWS=%d/%d; want matching projection and control requests", r2ChangedReport.ClassA, r2ChangedReport.DeleteRequests, awsChangedReport.ClassA, awsChangedReport.DeleteRequests)
	}
	if r2ChangedReport.ObjectRequests["PUT.projection"] != awsChangedReport.ObjectRequests["PUT.projection"] ||
		r2ChangedReport.ObjectRequests["DELETE.projection"] != awsChangedReport.ObjectRequests["DELETE.projection"] {
		t.Fatalf("changed projection writes/deletes R2=%d/%d AWS=%d/%d; want matching artifact/index mutations", r2ChangedReport.ObjectRequests["PUT.projection"], r2ChangedReport.ObjectRequests["DELETE.projection"], awsChangedReport.ObjectRequests["PUT.projection"], awsChangedReport.ObjectRequests["DELETE.projection"])
	}
	// The generated index and metadata include a volatile generatedAt value.
	// When sequential provider runs cross an RFC3339 second, preserveGeneratedAt
	// reads those two prior objects before deciding whether to retain their
	// deployed bytes. Count these as projection reads; they are independent of
	// the state-read policy being compared.
	for _, report := range []sitePublishV2CostReport{r2ChangedReport, awsChangedReport} {
		generatedAtReads := report.ObjectRequests["GET.projection"]
		if generatedAtReads != 0 && generatedAtReads != 2 {
			t.Fatalf("%s changed flow made %d projection GETs; want 0 or the two generatedAt preservation reads", report.Provider, generatedAtReads)
		}
	}
	if r2ChangedReport.StateBodyReadBytes <= 0 || awsChangedReport.StateBodyReadBytes <= 0 {
		t.Fatalf("changed state body bytes R2/AWS = %d/%d; want both state GETs to read bytes", r2ChangedReport.StateBodyReadBytes, awsChangedReport.StateBodyReadBytes)
	}
	if r2ChangedReport.ObjectRequests["PUT.journal"] != 1 || awsChangedReport.ObjectRequests["PUT.journal"] != 1 ||
		r2ChangedReport.ObjectRequests["DELETE.journal"] != 1 || awsChangedReport.ObjectRequests["DELETE.journal"] != 1 {
		t.Fatalf("changed journal requests R2=%v AWS=%v; want one durable journal write and clear each", r2ChangedReport.ObjectRequests, awsChangedReport.ObjectRequests)
	}
	if err := sitePublishV2CostRequireSameNonStateRequests(r2ChangedReport.ObjectRequests, awsChangedReport.ObjectRequests); err != nil {
		t.Fatal(err)
	}
	if r2ChangedReport.CDNInvalidationRequests != 1 || awsChangedReport.CDNInvalidationRequests != 1 {
		t.Fatalf("changed CDN requests R2/AWS = %d/%d; want one revalidation call each, separately from object request classes", r2ChangedReport.CDNInvalidationRequests, awsChangedReport.CDNInvalidationRequests)
	}
	if err := sitePublishV2CostAssertWriteOrdering(r2ChangedSnapshot.Events); err != nil {
		t.Fatalf("R2 write ordering: %v", err)
	}
	if err := sitePublishV2CostAssertWriteOrdering(awsChangedSnapshot.Events); err != nil {
		t.Fatalf("AWS write ordering: %v", err)
	}
}

func sitePublishV2CostRequireSameNonStateRequests(left, right map[string]int) error {
	keys := make(map[string]struct{}, len(left)+len(right))
	for key := range left {
		keys[key] = struct{}{}
	}
	for key := range right {
		keys[key] = struct{}{}
	}
	for key := range keys {
		if strings.HasSuffix(key, ".state") || strings.HasSuffix(key, ".projection") || strings.HasSuffix(key, ".total") {
			continue
		}
		if left[key] != right[key] {
			return fmt.Errorf("non-state operation %s differs: R2=%d AWS=%d", key, left[key], right[key])
		}
	}
	return nil
}

func sitePublishV2CostAssertWriteOrdering(events []string) error {
	journalPut, firstProjectionWrite, lastProjectionWrite, statePut := -1, -1, -1, -1
	statePutCount := 0
	for index, event := range events {
		switch event {
		case "PUT.journal":
			if journalPut == -1 {
				journalPut = index
			}
		case "PUT.state":
			statePut = index
			statePutCount++
		case "PUT.projection", "DELETE.projection":
			if firstProjectionWrite == -1 {
				firstProjectionWrite = index
			}
			lastProjectionWrite = index
		}
	}
	if journalPut == -1 || firstProjectionWrite == -1 || journalPut >= firstProjectionWrite {
		return fmt.Errorf("durable journal write must precede origin writes: %v", events)
	}
	if statePutCount != 1 || statePut <= lastProjectionWrite {
		return fmt.Errorf("expected exactly one final state-root PUT after all projection writes; got count=%d index=%d lastProjection=%d events=%v", statePutCount, statePut, lastProjectionWrite, events)
	}
	return nil
}

func sitePublishV2CostCloudflare(t *testing.T, client *sitePublishV2CostS3) (*cloudflareBackend, *sitePublishV2CostPurgeCounter) {
	t.Helper()
	counter := &sitePublishV2CostPurgeCounter{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		counter.mu.Lock()
		counter.callCount++
		counter.mu.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"success":true,"result":{"id":"r2-cost-test"}}`))
	}))
	t.Cleanup(server.Close)
	publicBase, err := url.Parse("https://pages.example.com")
	if err != nil {
		t.Fatal(err)
	}
	objects, err := newS3CompatibleBackend(client, "cost-test")
	if err != nil {
		t.Fatal(err)
	}
	return &cloudflareBackend{
		objects: objects, zoneID: "0123456789abcdef0123456789abcdef", baseURL: publicBase,
		apiToken: "cost-test-token", apiBaseURL: server.URL, httpClient: server.Client(),
	}, counter
}

type sitePublishV2CostPurgeCounter struct {
	mu        sync.Mutex
	callCount int
}

func (counter *sitePublishV2CostPurgeCounter) reset() {
	counter.mu.Lock()
	counter.callCount = 0
	counter.mu.Unlock()
}

func (counter *sitePublishV2CostPurgeCounter) calls() int {
	counter.mu.Lock()
	defer counter.mu.Unlock()
	return counter.callCount
}

type sitePublishV2CostCloudFront struct {
	mu        sync.Mutex
	callCount int
}

func (client *sitePublishV2CostCloudFront) CreateInvalidation(_ context.Context, _ *cloudfront.CreateInvalidationInput, _ ...func(*cloudfront.Options)) (*cloudfront.CreateInvalidationOutput, error) {
	client.mu.Lock()
	client.callCount++
	index := client.callCount
	client.mu.Unlock()
	return &cloudfront.CreateInvalidationOutput{Invalidation: &cloudfronttypes.Invalidation{Id: aws.String(fmt.Sprintf("aws-cost-%d", index))}}, nil
}

func (client *sitePublishV2CostCloudFront) reset() {
	client.mu.Lock()
	client.callCount = 0
	client.mu.Unlock()
}

func (client *sitePublishV2CostCloudFront) calls() int {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.callCount
}

type sitePublishV2CostCacheFailureBackend struct {
	*sitePublishV2RecoveryBackend
	failInvalidateOnce bool
}

func (backend *sitePublishV2CostCacheFailureBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	if backend.failInvalidateOnce {
		backend.failInvalidateOnce = false
		return "", errors.New("injected cache invalidation failure after origin commit")
	}
	return backend.sitePublishV2RecoveryBackend.sitePublishScaleBackend.Invalidate(ctx, paths)
}

type sitePublishV2CostJournalCaptureBackend struct {
	*sitePublishV2RecoveryBackend
	journalWrites []siteCacheRetry
}

func (backend *sitePublishV2CostJournalCaptureBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	if key == siteCacheRetryKey("sre") {
		var record siteCacheRetry
		if err := json.Unmarshal(object.Bytes, &record); err != nil {
			return "", fmt.Errorf("capture cache journal: %w", err)
		}
		backend.journalWrites = append(backend.journalWrites, record)
	}
	return backend.sitePublishV2RecoveryBackend.PutObjectConditional(ctx, key, object, condition)
}

func TestPublishSiteCompletedCacheFailureStartsNewTransactionAndUnionsPaths(t *testing.T) {
	root, store, options := sitePublishV2RecoveryFixture(t)
	failedPath := filepath.Join(root, "docs", "artifacts", "assets", "attempt-only.css")
	if err := os.MkdirAll(filepath.Dir(failedPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(failedPath, []byte("body{--attempt-only:1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	firstStoreWrapper := newSitePublishV2RecoveryBackend(store)
	first := &sitePublishV2CostCacheFailureBackend{sitePublishV2RecoveryBackend: firstStoreWrapper, failInvalidateOnce: true}
	if _, err := PublishSite(context.Background(), first, options); err == nil || !strings.Contains(err.Error(), "cache revalidation failed") {
		t.Fatalf("first publish cache failure = %v; want post-commit invalidation failure", err)
	}
	stateAfterFailure, _, _ := sitePublishV2RecoveryReadState(t, store)
	firstJournal, _ := sitePublishV2RecoveryReadCache(t, store)
	if firstJournal.Transaction == nil || stateAfterFailure.Committed.Generation != firstJournal.Transaction.ID {
		t.Fatalf("completed generation/journal after cache failure = %q/%+v; want completed transaction retained for cache retry", stateAfterFailure.Committed.Generation, firstJournal.Transaction)
	}
	if got := store.objectBytes("_artifacts/sre/assets/attempt-only.css"); got != "body{--attempt-only:1}\n" {
		t.Fatalf("origin object after cache failure = %q; want first transaction's object committed", got)
	}
	if !containsString(firstJournal.Paths, "/_artifacts/sre/assets/attempt-only.css") {
		t.Fatalf("first cache paths omit committed object: %v", firstJournal.Paths)
	}

	// The latest tree reverts the first transaction's new key and introduces a
	// different key. The completed old generation must not be replayed as an
	// active origin transaction, and its purge path must survive in the new
	// transaction's monotone cache-path union.
	if err := os.Remove(failedPath); err != nil {
		t.Fatal(err)
	}
	latestPath := filepath.Join(root, "docs", "artifacts", "assets", "latest.css")
	if err := os.WriteFile(latestPath, []byte("body{--latest:1}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	restarted := &sitePublishV2CostJournalCaptureBackend{sitePublishV2RecoveryBackend: newSitePublishV2RecoveryBackend(store)}
	result, err := PublishSite(context.Background(), restarted, options)
	if err != nil || result.Outcome != "published" {
		t.Fatalf("fresh-wrapper changed/reverted retry = %+v, err=%v", result, err)
	}
	if len(restarted.journalWrites) != 1 {
		t.Fatalf("fresh-wrapper wrote %d cache journals, want one replacing completed transaction intent", len(restarted.journalWrites))
	}
	secondJournal := restarted.journalWrites[0]
	if secondJournal.Transaction == nil || secondJournal.Transaction.ID == firstJournal.Transaction.ID ||
		secondJournal.Transaction.BaseGeneration != firstJournal.Transaction.ID {
		t.Fatalf("retry transaction = %+v; want fresh ID based on completed prior generation %q", secondJournal.Transaction, firstJournal.Transaction.ID)
	}
	for _, path := range []string{"/_artifacts/sre/assets/attempt-only.css", "/_artifacts/sre/assets/latest.css"} {
		if !containsString(secondJournal.Paths, path) || !containsString(result.InvalidationPaths, path) {
			t.Errorf("new retry path union %v / result %v omits %s", secondJournal.Paths, result.InvalidationPaths, path)
		}
	}
	if !containsString(secondJournal.Transaction.TouchedKeys, "_artifacts/sre/assets/attempt-only.css") ||
		!containsString(secondJournal.Transaction.TouchedKeys, "_artifacts/sre/assets/latest.css") {
		t.Errorf("new transaction touched keys = %v; want reverted and latest resource keys", secondJournal.Transaction.TouchedKeys)
	}
	finalState, _, _ := sitePublishV2RecoveryReadState(t, store)
	if finalState.Committed.Generation != secondJournal.Transaction.ID {
		t.Fatalf("final state generation = %q; want new retry transaction %q", finalState.Committed.Generation, secondJournal.Transaction.ID)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), "_artifacts/sre/assets/attempt-only.css"); !errors.Is(err, ErrObjectNotFound) {
		t.Errorf("reverted failed-run object remains after retry: %v", err)
	}
	if got := store.objectBytes("_artifacts/sre/assets/latest.css"); got != "body{--latest:1}\n" {
		t.Errorf("latest resource after retry = %q", got)
	}
	if _, _, err := store.lockMemoryBackend.GetObject(context.Background(), siteCacheRetryKey("sre")); !errors.Is(err, ErrObjectNotFound) {
		t.Errorf("cache journal after completed retry = %v; want cleared", err)
	}
}
