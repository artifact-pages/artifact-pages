package publisher

import (
	"bytes"
	"context"
	"io"
	"reflect"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type getObjectMetadataS3 struct {
	s3API
	input  *s3.GetObjectInput
	output *s3.GetObjectOutput
}

func (client *getObjectMetadataS3) GetObject(_ context.Context, input *s3.GetObjectInput, _ ...func(*s3.Options)) (*s3.GetObjectOutput, error) {
	client.input = input
	return client.output, nil
}

func TestS3CompatibleGetObjectPreservesHTTPMetadataAndETag(t *testing.T) {
	contents := []byte("compressed artifact")
	client := &getObjectMetadataS3{output: &s3.GetObjectOutput{
		Body:               io.NopCloser(bytes.NewReader(contents)),
		ContentType:        aws.String("text/html; charset=utf-8"),
		ContentDisposition: aws.String(`inline; filename="report.html"`),
		ContentEncoding:    aws.String("gzip"),
		CacheControl:       aws.String("public, max-age=60"),
		Metadata:           map[string]string{"artifact-pages-sha256": "abc123", "source": "test"},
		ETag:               aws.String(`"object-v7"`),
	}}
	backend, err := newS3CompatibleBackend(client, "fixture-bucket")
	if err != nil {
		t.Fatalf("newS3CompatibleBackend() error = %v", err)
	}

	got, gotETag, err := backend.GetObject(context.Background(), "_control/publish-state/verify.json.gz")
	if err != nil {
		t.Fatalf("GetObject() error = %v", err)
	}
	want := Object{
		Bytes: contents, ContentType: "text/html; charset=utf-8",
		ContentDisposition: `inline; filename="report.html"`, ContentEncoding: "gzip",
		Cache: "public, max-age=60", Metadata: map[string]string{"artifact-pages-sha256": "abc123", "source": "test"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("GetObject() object = %#v, want %#v", got, want)
	}
	if gotETag != `"object-v7"` {
		t.Fatalf("GetObject() ETag = %q, want %q", gotETag, `"object-v7"`)
	}
	if aws.ToString(client.input.Bucket) != "fixture-bucket" || aws.ToString(client.input.Key) != "_control/publish-state/verify.json.gz" {
		t.Fatalf("GetObject() input = bucket %q key %q, want fixture bucket and requested state key", aws.ToString(client.input.Bucket), aws.ToString(client.input.Key))
	}
}

func TestCloudflareUsesGetOnlyPrivateStateReadAndS3DefaultsToHeadThenGet(t *testing.T) {
	client := &getObjectMetadataS3{}
	objects, err := newS3CompatibleBackend(client, "fixture-bucket")
	if err != nil {
		t.Fatalf("newS3CompatibleBackend() error = %v", err)
	}
	cloudflare := &cloudflareBackend{objects: objects}
	if got := selectedPublishStateReadMode(cloudflare); got != publishStateReadGetOnly {
		t.Errorf("Cloudflare state-read mode = %v, want GET-only", got)
	}

	awsBackend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "fixture-bucket"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	if got := selectedPublishStateReadMode(awsBackend); got != publishStateReadHeadThenGet {
		t.Errorf("AWS state-read mode = %v, want default HEAD-then-GET", got)
	}
	if _, implementsPolicy := any(objects).(publishStateReadPolicy); implementsPolicy {
		t.Error("default S3-compatible backend advertises a provider-specific private state read mode")
	}
}
