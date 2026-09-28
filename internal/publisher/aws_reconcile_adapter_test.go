package publisher

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type awsReconcileAdapterS3 struct {
	listObjects   func(context.Context, *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error)
	deleteObjects func(context.Context, *s3.DeleteObjectsInput) (*s3.DeleteObjectsOutput, error)
	putObject     func(context.Context, *s3.PutObjectInput) (*s3.PutObjectOutput, error)
	headObject    func(context.Context, *s3.HeadObjectInput) (*s3.HeadObjectOutput, error)
}

func (client *awsReconcileAdapterS3) PutObject(ctx context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	if client.putObject == nil {
		return &s3.PutObjectOutput{}, nil
	}
	return client.putObject(ctx, input)
}

func (client *awsReconcileAdapterS3) ListObjectsV2(ctx context.Context, input *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	if client.listObjects == nil {
		return &s3.ListObjectsV2Output{}, nil
	}
	return client.listObjects(ctx, input)
}

func (client *awsReconcileAdapterS3) DeleteObjects(ctx context.Context, input *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	if client.deleteObjects == nil {
		return &s3.DeleteObjectsOutput{}, nil
	}
	return client.deleteObjects(ctx, input)
}

func (client *awsReconcileAdapterS3) HeadObject(ctx context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	if client.headObject == nil {
		return &s3.HeadObjectOutput{}, nil
	}
	return client.headObject(ctx, input)
}

func TestAWSReconcileListKeysPaginatesAndPassesContinuationToken(t *testing.T) {
	var requests []*s3.ListObjectsV2Input
	client := &awsReconcileAdapterS3{}
	client.listObjects = func(_ context.Context, input *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
		requests = append(requests, input)
		switch len(requests) {
		case 1:
			return &s3.ListObjectsV2Output{
				Contents:              []types.Object{{Key: aws.String("_artifacts/sre/a.html")}},
				IsTruncated:           aws.Bool(true),
				NextContinuationToken: aws.String("next-page"),
			}, nil
		case 2:
			return &s3.ListObjectsV2Output{
				Contents:    []types.Object{{Key: aws.String("_artifacts/sre/b.html")}},
				IsTruncated: aws.Bool(false),
			}, nil
		default:
			return nil, fmt.Errorf("unexpected listing request %d", len(requests))
		}
	}

	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-prod"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	keys, err := backend.ListKeys(context.Background(), "_artifacts/sre/")
	if err != nil {
		t.Fatalf("ListKeys() error = %v", err)
	}
	if want := []string{"_artifacts/sre/a.html", "_artifacts/sre/b.html"}; !reflect.DeepEqual(keys, want) {
		t.Fatalf("ListKeys() = %v, want %v", keys, want)
	}
	if len(requests) != 2 {
		t.Fatalf("ListObjectsV2 calls = %d, want 2", len(requests))
	}
	for index, request := range requests {
		if got := aws.ToString(request.Bucket); got != "pages-prod" {
			t.Errorf("request %d bucket = %q, want pages-prod", index+1, got)
		}
		if got := aws.ToString(request.Prefix); got != "_artifacts/sre/" {
			t.Errorf("request %d prefix = %q, want _artifacts/sre/", index+1, got)
		}
	}
	if requests[0].ContinuationToken != nil {
		t.Errorf("first page continuation token = %q, want nil", aws.ToString(requests[0].ContinuationToken))
	}
	if got := aws.ToString(requests[1].ContinuationToken); got != "next-page" {
		t.Errorf("second page continuation token = %q, want next-page", got)
	}
}

func TestAWSReconcileListKeysRejectsTruncatedPageWithoutToken(t *testing.T) {
	for _, test := range []struct {
		name  string
		token *string
	}{
		{name: "nil token"},
		{name: "empty token", token: aws.String("")},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			client := &awsReconcileAdapterS3{
				listObjects: func(_ context.Context, _ *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
					calls++
					return &s3.ListObjectsV2Output{IsTruncated: aws.Bool(true), NextContinuationToken: test.token}, nil
				},
			}

			_, err := listKeys(context.Background(), client, "pages-prod", "_artifacts/sre/")
			if err == nil || !strings.Contains(err.Error(), "truncated listing without a continuation token") {
				t.Fatalf("listKeys() error = %v, want missing continuation token error", err)
			}
			if calls != 1 {
				t.Fatalf("ListObjectsV2 calls = %d, want 1 after malformed truncated response", calls)
			}
		})
	}
}

func TestAWSReconcileListKeysRejectsIncompleteResponses(t *testing.T) {
	tests := []struct {
		name    string
		respond func(int) (*s3.ListObjectsV2Output, error)
		wantErr string
	}{
		{
			name:    "nil response",
			respond: func(int) (*s3.ListObjectsV2Output, error) { return nil, nil },
			wantErr: "empty listing response",
		},
		{
			name: "missing truncation status",
			respond: func(int) (*s3.ListObjectsV2Output, error) {
				return &s3.ListObjectsV2Output{}, nil
			},
			wantErr: "missing truncation status",
		},
		{
			name: "object missing key",
			respond: func(int) (*s3.ListObjectsV2Output, error) {
				return &s3.ListObjectsV2Output{IsTruncated: aws.Bool(false), Contents: []types.Object{{}}}, nil
			},
			wantErr: "object without a key",
		},
		{
			name: "object outside requested prefix",
			respond: func(int) (*s3.ListObjectsV2Output, error) {
				return &s3.ListObjectsV2Output{IsTruncated: aws.Bool(false), Contents: []types.Object{{Key: aws.String("_artifacts/other/private.html")}}}, nil
			},
			wantErr: "outside requested prefix",
		},
		{
			name: "repeated continuation token",
			respond: func(call int) (*s3.ListObjectsV2Output, error) {
				if call == 1 {
					return &s3.ListObjectsV2Output{IsTruncated: aws.Bool(true), NextContinuationToken: aws.String("same-token")}, nil
				}
				return &s3.ListObjectsV2Output{IsTruncated: aws.Bool(true), NextContinuationToken: aws.String("same-token")}, nil
			},
			wantErr: "repeated continuation token",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			client := &awsReconcileAdapterS3{
				listObjects: func(_ context.Context, _ *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
					calls++
					return test.respond(calls)
				},
			}

			_, err := listKeys(context.Background(), client, "pages-prod", "_artifacts/sre/")
			if err == nil || !strings.Contains(err.Error(), test.wantErr) {
				t.Fatalf("listKeys() error = %v, want an error containing %q", err, test.wantErr)
			}
			if calls > 2 {
				t.Fatalf("ListObjectsV2 calls = %d, want the malformed listing rejected promptly", calls)
			}
		})
	}
}

func TestAWSReconcileDeleteObjectsUsesBoundedBatches(t *testing.T) {
	keys := make([]string, 2001)
	for index := range keys {
		keys[index] = fmt.Sprintf("_artifacts/sre/%04d.html", index)
	}
	var requests []*s3.DeleteObjectsInput
	client := &awsReconcileAdapterS3{
		deleteObjects: func(_ context.Context, input *s3.DeleteObjectsInput) (*s3.DeleteObjectsOutput, error) {
			requests = append(requests, input)
			return &s3.DeleteObjectsOutput{}, nil
		},
	}

	if err := deleteKeys(context.Background(), client, "pages-prod", keys); err != nil {
		t.Fatalf("deleteKeys() error = %v", err)
	}
	if len(requests) != 3 {
		t.Fatalf("DeleteObjects calls = %d, want 3", len(requests))
	}
	wantBatchSizes := []int{1000, 1000, 1}
	for requestIndex, request := range requests {
		if got := aws.ToString(request.Bucket); got != "pages-prod" {
			t.Errorf("request %d bucket = %q, want pages-prod", requestIndex+1, got)
		}
		if got, want := len(request.Delete.Objects), wantBatchSizes[requestIndex]; got != want {
			t.Errorf("request %d contains %d keys, want %d", requestIndex+1, got, want)
		}
		if request.Delete.Quiet == nil || !aws.ToBool(request.Delete.Quiet) {
			t.Errorf("request %d Quiet = %v, want true", requestIndex+1, request.Delete.Quiet)
		}
		start := requestIndex * 1000
		end := min(start+1000, len(keys))
		gotKeys := make([]string, len(request.Delete.Objects))
		for index, object := range request.Delete.Objects {
			gotKeys[index] = aws.ToString(object.Key)
		}
		if want := keys[start:end]; !reflect.DeepEqual(gotKeys, want) {
			t.Errorf("request %d keys do not match input batch", requestIndex+1)
		}
	}

	var emptyCalls int
	emptyClient := &awsReconcileAdapterS3{
		deleteObjects: func(_ context.Context, _ *s3.DeleteObjectsInput) (*s3.DeleteObjectsOutput, error) {
			emptyCalls++
			return &s3.DeleteObjectsOutput{}, nil
		},
	}
	if err := deleteKeys(context.Background(), emptyClient, "pages-prod", nil); err != nil {
		t.Fatalf("deleteKeys(empty) error = %v", err)
	}
	if emptyCalls != 0 {
		t.Errorf("DeleteObjects calls for empty key list = %d, want 0", emptyCalls)
	}
}

func TestAWSReconcileDeleteObjectsPropagatesPerObjectFailure(t *testing.T) {
	client := &awsReconcileAdapterS3{
		deleteObjects: func(_ context.Context, _ *s3.DeleteObjectsInput) (*s3.DeleteObjectsOutput, error) {
			return &s3.DeleteObjectsOutput{Errors: []types.Error{{
				Key: aws.String("_artifacts/sre/stale.html"), Code: aws.String("AccessDenied"), Message: aws.String("permission denied"),
			}}}, nil
		},
	}

	err := deleteKeys(context.Background(), client, "pages-prod", []string{"_artifacts/sre/stale.html"})
	if err == nil {
		t.Fatal("deleteKeys() error = nil, want per-object S3 failure")
	}
	for _, want := range []string{"_artifacts/sre/stale.html", "permission denied"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("deleteKeys() error = %q, want it to include %q", err, want)
		}
	}
}

func TestAWSReconcileDeleteObjectsRejectsEmptyResponse(t *testing.T) {
	client := &awsReconcileAdapterS3{
		deleteObjects: func(_ context.Context, _ *s3.DeleteObjectsInput) (*s3.DeleteObjectsOutput, error) {
			return nil, nil
		},
	}
	if err := deleteKeys(context.Background(), client, "pages-prod", []string{"_artifacts/sre/stale.html"}); err == nil || !strings.Contains(err.Error(), "empty delete response") {
		t.Fatalf("deleteKeys() error = %v, want an empty-response error", err)
	}
}

func TestAWSReconcilePutObjectForwardsBrowserMetadata(t *testing.T) {
	wantBytes := []byte("<h1>Report</h1>")
	wantMetadata := map[string]string{"artifact-pages-site": "sre", "artifact-pages-sha256": "abc123"}
	var gotInput *s3.PutObjectInput
	var gotBytes []byte
	client := &awsReconcileAdapterS3{
		putObject: func(_ context.Context, input *s3.PutObjectInput) (*s3.PutObjectOutput, error) {
			gotInput = input
			var err error
			gotBytes, err = io.ReadAll(input.Body)
			if err != nil {
				return nil, err
			}
			return &s3.PutObjectOutput{}, nil
		},
	}
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-prod"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	object := Object{
		Bytes:              wantBytes,
		ContentType:        "text/html; charset=utf-8",
		ContentDisposition: "inline",
		ContentEncoding:    "",
		Cache:              "public, max-age=0, s-maxage=300, must-revalidate",
		Metadata:           wantMetadata,
	}
	if err := backend.PutObject(context.Background(), "_artifacts/sre/report.html", object); err != nil {
		t.Fatalf("PutObject() error = %v", err)
	}
	if !bytes.Equal(gotBytes, wantBytes) {
		t.Errorf("uploaded bytes = %q, want %q", gotBytes, wantBytes)
	}
	if got := aws.ToString(gotInput.Bucket); got != "pages-prod" {
		t.Errorf("PutObject bucket = %q, want pages-prod", got)
	}
	if got := aws.ToString(gotInput.Key); got != "_artifacts/sre/report.html" {
		t.Errorf("PutObject key = %q, want _artifacts/sre/report.html", got)
	}
	if got := aws.ToString(gotInput.ContentType); got != object.ContentType {
		t.Errorf("ContentType = %q, want %q", got, object.ContentType)
	}
	if got := aws.ToString(gotInput.ContentDisposition); got != object.ContentDisposition {
		t.Errorf("ContentDisposition = %q, want %q", got, object.ContentDisposition)
	}
	if got := aws.ToString(gotInput.ContentEncoding); got != object.ContentEncoding {
		t.Errorf("ContentEncoding = %q, want %q", got, object.ContentEncoding)
	}
	if got := aws.ToString(gotInput.CacheControl); got != object.Cache {
		t.Errorf("CacheControl = %q, want %q", got, object.Cache)
	}
	if !reflect.DeepEqual(gotInput.Metadata, wantMetadata) {
		t.Errorf("Metadata = %#v, want %#v", gotInput.Metadata, wantMetadata)
	}
}

func TestAWSReconcileHeadObjectReturnsBrowserMetadata(t *testing.T) {
	client := &awsReconcileAdapterS3{
		headObject: func(_ context.Context, input *s3.HeadObjectInput) (*s3.HeadObjectOutput, error) {
			if got := aws.ToString(input.Key); got != "_artifacts/sre/report.html" {
				t.Fatalf("HeadObject key = %q", got)
			}
			return &s3.HeadObjectOutput{
				ETag: aws.String(`"etag"`), ContentLength: aws.Int64(42),
				ContentType: aws.String("text/html; charset=utf-8"), ContentDisposition: aws.String("inline"),
				ContentEncoding: aws.String("gzip"), CacheControl: aws.String("public, max-age=0, s-maxage=300, must-revalidate"),
				Metadata: map[string]string{"artifact-pages-sha256": "abc"},
			}, nil
		},
	}
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-prod"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}
	info, err := backend.HeadObject(context.Background(), "_artifacts/sre/report.html")
	if err != nil {
		t.Fatalf("HeadObject() error = %v", err)
	}
	if info.ContentType != "text/html; charset=utf-8" || info.ContentDisposition != "inline" || info.ContentEncoding != "gzip" || info.CacheControl != "public, max-age=0, s-maxage=300, must-revalidate" {
		t.Fatalf("HeadObject() representation metadata = type %q, disposition %q, encoding %q, cache %q", info.ContentType, info.ContentDisposition, info.ContentEncoding, info.CacheControl)
	}
	if info.Metadata["artifact-pages-sha256"] != "abc" {
		t.Fatalf("HeadObject() checksum metadata = %#v", info.Metadata)
	}
}

func TestMapS3ConditionErrorRequiresConfirmedMissingKey(t *testing.T) {
	tests := []struct {
		name          string
		err           error
		wantNotFound  bool
		wantPrecond   bool
		wantUnchanged bool
	}{
		{name: "NoSuchKey 404", err: s3ResponseError(404, "NoSuchKey"), wantNotFound: true},
		{name: "NoSuchBucket 404", err: s3ResponseError(404, "NoSuchBucket"), wantUnchanged: true},
		{name: "generic 404", err: s3ResponseError(404, "NotFound"), wantUnchanged: true},
		{name: "unknown 404", err: s3ResponseError(404, ""), wantUnchanged: true},
		{name: "conditional conflict 409", err: s3ResponseError(409, "ConditionalRequestConflict"), wantPrecond: true},
		{name: "precondition failed 412", err: s3ResponseError(412, "PreconditionFailed"), wantPrecond: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := mapS3ConditionError(test.err)
			if errors.Is(got, ErrObjectNotFound) != test.wantNotFound {
				t.Errorf("mapS3ConditionError() ErrObjectNotFound = %v, want %v (error: %v)", errors.Is(got, ErrObjectNotFound), test.wantNotFound, got)
			}
			if errors.Is(got, ErrPreconditionFailed) != test.wantPrecond {
				t.Errorf("mapS3ConditionError() ErrPreconditionFailed = %v, want %v (error: %v)", errors.Is(got, ErrPreconditionFailed), test.wantPrecond, got)
			}
			if test.wantUnchanged && got != test.err {
				t.Errorf("mapS3ConditionError() = %v, want original error %v", got, test.err)
			}
		})
	}
}

func TestAWSHeadObjectConfirmsAmbiguous404WithScopedListing(t *testing.T) {
	const key = "_artifacts/sre/manifest.json"
	tests := []struct {
		name             string
		contents         []types.Object
		listErr          error
		wantNotFound     bool
		wantStatus404    bool
		wantListRequests int
	}{
		{name: "missing key", wantNotFound: true, wantListRequests: 1},
		{name: "same key is listed", contents: []types.Object{{Key: aws.String(key)}}, wantStatus404: true, wantListRequests: 1},
		{name: "only a longer prefix match is listed", contents: []types.Object{{Key: aws.String(key + ".backup")}}, wantNotFound: true, wantListRequests: 1},
		{name: "list denied", listErr: s3ResponseError(403, "AccessDenied"), wantStatus404: true, wantListRequests: 1},
		{name: "bucket missing", listErr: s3ResponseError(404, "NoSuchBucket"), wantStatus404: true, wantListRequests: 1},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requests []*s3.ListObjectsV2Input
			client := &awsReconcileAdapterS3{
				headObject: func(_ context.Context, _ *s3.HeadObjectInput) (*s3.HeadObjectOutput, error) {
					return nil, s3ResponseError(404, "NotFound")
				},
				listObjects: func(_ context.Context, input *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
					requests = append(requests, input)
					if test.listErr != nil {
						return nil, test.listErr
					}
					return &s3.ListObjectsV2Output{Contents: test.contents, IsTruncated: aws.Bool(false)}, nil
				},
			}
			backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "pages-prod"})
			if err != nil {
				t.Fatalf("newAWSBackend() error = %v", err)
			}

			_, gotErr := backend.HeadObject(context.Background(), key)
			if errors.Is(gotErr, ErrObjectNotFound) != test.wantNotFound {
				t.Errorf("HeadObject() ErrObjectNotFound = %v, want %v (error: %v)", errors.Is(gotErr, ErrObjectNotFound), test.wantNotFound, gotErr)
			}
			if isS3ResponseStatus(gotErr, 404) != test.wantStatus404 {
				t.Errorf("HeadObject() retains 404 = %v, want %v (error: %v)", isS3ResponseStatus(gotErr, 404), test.wantStatus404, gotErr)
			}
			if len(requests) != test.wantListRequests {
				t.Fatalf("ListObjectsV2 calls = %d, want %d", len(requests), test.wantListRequests)
			}
			if len(requests) > 0 {
				if got := aws.ToString(requests[0].Bucket); got != "pages-prod" {
					t.Errorf("confirmation bucket = %q, want pages-prod", got)
				}
				if got := aws.ToString(requests[0].Prefix); got != key {
					t.Errorf("confirmation prefix = %q, want exact key %q", got, key)
				}
			}
		})
	}
}

func TestAWSHeadObjectDoesNotListAfterNoSuchBucket404(t *testing.T) {
	listCalls := 0
	client := &awsReconcileAdapterS3{
		headObject: func(_ context.Context, _ *s3.HeadObjectInput) (*s3.HeadObjectOutput, error) {
			return nil, s3ResponseError(404, "NoSuchBucket")
		},
		listObjects: func(_ context.Context, _ *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
			listCalls++
			return &s3.ListObjectsV2Output{IsTruncated: aws.Bool(false)}, nil
		},
	}
	backend, err := newAWSBackend(awsClients{s3: client}, AWSOptions{Bucket: "missing-bucket"})
	if err != nil {
		t.Fatalf("newAWSBackend() error = %v", err)
	}

	_, gotErr := backend.HeadObject(context.Background(), "_artifacts/sre/manifest.json")
	if errors.Is(gotErr, ErrObjectNotFound) {
		t.Fatalf("HeadObject() error = %v, want NoSuchBucket to remain unclassified", gotErr)
	}
	if listCalls != 0 {
		t.Fatalf("ListObjectsV2 calls = %d, want 0 for NoSuchBucket", listCalls)
	}
}

func s3ResponseError(status int, code string) error {
	return &smithyhttp.ResponseError{
		Response: &smithyhttp.Response{Response: &http.Response{StatusCode: status}},
		Err:      &smithy.GenericAPIError{Code: code, Message: "test response", Fault: smithy.FaultClient},
	}
}
