package publisher

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

func TestPublishSiteStopsWhenS3ArtifactListingContinuationFails(t *testing.T) {
	createPublisherCheckout(t, "git@github.com:acme/sre.git")

	registryBytes := mustRegistryProjection(t)
	staleBytes := []byte("stale artifact")
	client := &awsReconcileFailureS3{
		objects: map[string]awsReconcileFailureObject{
			"_indexes/sites.json":       {bytes: registryBytes, etag: `"registry-v1"`},
			"_artifacts/sre/stale.html": {bytes: staleBytes, etag: `"stale-v1"`},
		},
	}
	client.adapter = &awsReconcileAdapterS3{
		listObjects: client.listObjects,
		putObject:   client.putObject,
		headObject:  client.headObject,
		deleteObjects: func(_ context.Context, input *s3.DeleteObjectsInput) (*s3.DeleteObjectsOutput, error) {
			client.deleteCalls++
			return &s3.DeleteObjectsOutput{}, nil
		},
	}
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-prod"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}

	_, err = PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err == nil || !strings.Contains(err.Error(), "injected second-page S3 listing failure") {
		t.Fatalf("PublishSite() error = %v, want continuation-page listing failure", err)
	}

	if len(client.listRequests) != 2 {
		t.Fatalf("ListObjectsV2 calls = %d, want two artifact pages", len(client.listRequests))
	}
	first, second := client.listRequests[0], client.listRequests[1]
	if got := aws.ToString(first.Prefix); got != "_artifacts/sre/" {
		t.Fatalf("first listing prefix = %q, want _artifacts/sre/", got)
	}
	if first.ContinuationToken != nil {
		t.Errorf("first listing continuation token = %q, want nil", aws.ToString(first.ContinuationToken))
	}
	if got := aws.ToString(second.Prefix); got != "_artifacts/sre/" {
		t.Errorf("second listing prefix = %q, want _artifacts/sre/", got)
	}
	if got := aws.ToString(second.ContinuationToken); got != "next-page" {
		t.Errorf("second listing continuation token = %q, want next-page", got)
	}

	if client.deleteCalls != 0 {
		t.Errorf("DeleteObjects calls = %d, want 0 after incomplete listing", client.deleteCalls)
	}
	if got := client.objects["_artifacts/sre/stale.html"]; !bytes.Equal(got.bytes, staleBytes) {
		t.Errorf("stale artifact after failed listing = %q, want preserved %q", got.bytes, staleBytes)
	}
	if got := client.objects["_indexes/sites.json"]; !bytes.Equal(got.bytes, registryBytes) {
		t.Errorf("site registry changed after failed listing")
	}
	for _, key := range client.putKeys {
		if !strings.HasPrefix(key, "_control/locks/") {
			t.Errorf("content-plane PutObject %q occurred before listing completed", key)
		}
	}
	if client.indexPrefixListCalls != 0 {
		t.Errorf("index-prefix listing calls = %d, want 0 after artifact-prefix listing failure", client.indexPrefixListCalls)
	}
}

type awsReconcileFailureObject struct {
	bytes []byte
	etag  string
}

// awsReconcileFailureS3 combines the existing adapter fake with origin reads
// so PublishSite can exercise the real AWS backend and publication workflow.
type awsReconcileFailureS3 struct {
	adapter              *awsReconcileAdapterS3
	objects              map[string]awsReconcileFailureObject
	listRequests         []*s3.ListObjectsV2Input
	putKeys              []string
	deleteCalls          int
	indexPrefixListCalls int
	nextETag             int
}

func (client *awsReconcileFailureS3) PutObject(ctx context.Context, input *s3.PutObjectInput, options ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	return client.adapter.PutObject(ctx, input, options...)
}

func (client *awsReconcileFailureS3) ListObjectsV2(ctx context.Context, input *s3.ListObjectsV2Input, options ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	return client.adapter.ListObjectsV2(ctx, input, options...)
}

func (client *awsReconcileFailureS3) DeleteObjects(ctx context.Context, input *s3.DeleteObjectsInput, options ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	return client.adapter.DeleteObjects(ctx, input, options...)
}

func (client *awsReconcileFailureS3) GetObject(_ context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	key := aws.ToString(input.Key)
	object, exists := client.objects[key]
	if !exists {
		return nil, s3ResponseError(http.StatusNotFound, "NoSuchKey")
	}
	return &s3.GetObjectOutput{Body: io.NopCloser(bytes.NewReader(object.bytes)), ETag: aws.String(object.etag)}, nil
}

func (client *awsReconcileFailureS3) HeadObject(ctx context.Context, input *s3.HeadObjectInput, options ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	return client.adapter.HeadObject(ctx, input, options...)
}

func (client *awsReconcileFailureS3) headObject(_ context.Context, input *s3.HeadObjectInput) (*s3.HeadObjectOutput, error) {
	key := aws.ToString(input.Key)
	object, exists := client.objects[key]
	if !exists {
		return nil, s3ResponseError(http.StatusNotFound, "NoSuchKey")
	}
	length := int64(len(object.bytes))
	return &s3.HeadObjectOutput{ETag: aws.String(object.etag), ContentLength: &length}, nil
}

func (client *awsReconcileFailureS3) listObjects(_ context.Context, input *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
	client.listRequests = append(client.listRequests, input)
	prefix := aws.ToString(input.Prefix)
	if prefix == "_indexes/sre/" {
		client.indexPrefixListCalls++
	}
	if prefix != "_artifacts/sre/" {
		return nil, fmt.Errorf("unexpected ListObjectsV2 prefix %q", prefix)
	}
	if input.ContinuationToken == nil {
		return &s3.ListObjectsV2Output{
			Contents:              []types.Object{{Key: aws.String("_artifacts/sre/stale.html")}},
			IsTruncated:           aws.Bool(true),
			NextContinuationToken: aws.String("next-page"),
		}, nil
	}
	if got := aws.ToString(input.ContinuationToken); got != "next-page" {
		return nil, fmt.Errorf("unexpected continuation token %q", got)
	}
	return nil, errors.New("injected second-page S3 listing failure")
}

func (client *awsReconcileFailureS3) putObject(_ context.Context, input *s3.PutObjectInput) (*s3.PutObjectOutput, error) {
	key := aws.ToString(input.Key)
	client.putKeys = append(client.putKeys, key)
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	current, exists := client.objects[key]
	if input.IfNoneMatch != nil && aws.ToString(input.IfNoneMatch) == "*" && exists {
		return nil, &smithyhttp.ResponseError{
			Response: &smithyhttp.Response{Response: &http.Response{StatusCode: http.StatusPreconditionFailed}},
			Err:      errors.New("precondition failed"),
		}
	}
	if input.IfMatch != nil && (!exists || current.etag != aws.ToString(input.IfMatch)) {
		return nil, &smithyhttp.ResponseError{
			Response: &smithyhttp.Response{Response: &http.Response{StatusCode: http.StatusPreconditionFailed}},
			Err:      errors.New("precondition failed"),
		}
	}
	client.nextETag++
	etag := fmt.Sprintf(`"test-%d"`, client.nextETag)
	client.objects[key] = awsReconcileFailureObject{bytes: append([]byte(nil), body...), etag: etag}
	return &s3.PutObjectOutput{ETag: aws.String(etag)}, nil
}
