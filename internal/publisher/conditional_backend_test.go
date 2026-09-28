package publisher

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type recordingConditionalS3 struct {
	s3API
	input  *s3.PutObjectInput
	putErr error
}

func (client *recordingConditionalS3) PutObject(_ context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	client.input = input
	if client.putErr != nil {
		return nil, client.putErr
	}
	return &s3.PutObjectOutput{ETag: aws.String(`"next-etag"`)}, nil
}

func TestS3ConditionalWritesMapSharedLockConditionsForAWSAndR2(t *testing.T) {
	client := &recordingConditionalS3{}
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Region: "us-west-2", Bucket: "pages-prod"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	object := Object{Bytes: []byte(`{"state":"free"}`), ContentType: "application/json"}

	if etag, err := backend.PutObjectConditional(context.Background(), "_control/locks/sites/sre.json", object, ObjectCondition{IfNoneMatch: true}); err != nil || etag != `"next-etag"` {
		t.Fatalf("PutObjectConditional(IfNoneMatch) = %q, %v", etag, err)
	}
	if aws.ToString(client.input.IfNoneMatch) != "*" || client.input.IfMatch != nil {
		t.Fatalf("S3 create-if-absent conditions = IfNoneMatch:%q IfMatch:%q", aws.ToString(client.input.IfNoneMatch), aws.ToString(client.input.IfMatch))
	}

	if _, err := backend.PutObjectConditional(context.Background(), "_control/locks/sites/sre.json", object, ObjectCondition{IfMatchETag: `"current-etag"`}); err != nil {
		t.Fatalf("PutObjectConditional(IfMatchETag) error = %v", err)
	}
	if aws.ToString(client.input.IfMatch) != `"current-etag"` || client.input.IfNoneMatch != nil {
		t.Fatalf("S3 compare-and-swap conditions = IfNoneMatch:%q IfMatch:%q", aws.ToString(client.input.IfNoneMatch), aws.ToString(client.input.IfMatch))
	}

	// R2 delegates its S3-compatible lock writes through the same adapter.
	r2 := &cloudflareBackend{objects: backend.s3CompatibleBackend}
	if _, err := r2.PutObjectConditional(context.Background(), "_control/locks/sites/sre.json", object, ObjectCondition{IfMatchETag: `"r2-etag"`}); err != nil {
		t.Fatalf("Cloudflare PutObjectConditional() error = %v", err)
	}
	if aws.ToString(client.input.IfMatch) != `"r2-etag"` {
		t.Fatalf("R2 delegated If-Match = %q, want the observed ETag", aws.ToString(client.input.IfMatch))
	}

	client.putErr = &smithyhttp.ResponseError{Response: &smithyhttp.Response{Response: &http.Response{StatusCode: http.StatusPreconditionFailed}}}
	if _, err := backend.PutObjectConditional(context.Background(), "_control/locks/sites/sre.json", object, ObjectCondition{IfMatchETag: `"r2-etag"`}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("S3 HTTP 412 error = %v, want ErrPreconditionFailed", err)
	}
}
