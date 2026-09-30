package publisher

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

func TestS3CompatibleHeadObjectConfirmsAmbiguous404ByExactKey(t *testing.T) {
	const key = "_artifacts/sre/manifest.json"
	listDenied := s3ResponseError(403, "AccessDenied")
	tests := []struct {
		name             string
		headError        error
		listedObjects    []types.Object
		listError        error
		wantNotFound     bool
		wantSameHeadErr  bool
		wantListErr      bool
		wantListCalls    int
		wantListErrorMsg string
	}{
		{
			name:          "absent exact key",
			headError:     s3ResponseError(404, "NotFound"),
			wantNotFound:  true,
			wantListCalls: 1,
		},
		{
			name:          "only a longer prefix neighbor exists",
			headError:     s3ResponseError(404, "NotFound"),
			listedObjects: []types.Object{{Key: aws.String(key + ".backup")}},
			wantNotFound:  true,
			wantListCalls: 1,
		},
		{
			name:            "exact key is listed",
			headError:       s3ResponseError(404, "NotFound"),
			listedObjects:   []types.Object{{Key: aws.String(key)}},
			wantSameHeadErr: true,
			wantListCalls:   1,
		},
		{
			name:            "NoSuchBucket is not confirmed with a list",
			headError:       s3ResponseError(404, "NoSuchBucket"),
			wantSameHeadErr: true,
			wantListCalls:   0,
		},
		{
			name:             "list confirmation fails",
			headError:        s3ResponseError(404, "NotFound"),
			listError:        listDenied,
			wantSameHeadErr:  true,
			wantListErr:      true,
			wantListCalls:    1,
			wantListErrorMsg: "ListBucket confirmation failed",
		},
		{
			name:          "NoSuchKey remains a confirmed missing object",
			headError:     s3ResponseError(404, "NoSuchKey"),
			wantNotFound:  true,
			wantListCalls: 0,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			listCalls := 0
			var listPrefix string
			client := &awsReconcileAdapterS3{
				headObject: func(_ context.Context, _ *s3.HeadObjectInput) (*s3.HeadObjectOutput, error) {
					return nil, test.headError
				},
				listObjects: func(_ context.Context, input *s3.ListObjectsV2Input) (*s3.ListObjectsV2Output, error) {
					listCalls++
					listPrefix = aws.ToString(input.Prefix)
					if test.listError != nil {
						return nil, test.listError
					}
					return &s3.ListObjectsV2Output{Contents: test.listedObjects, IsTruncated: aws.Bool(false)}, nil
				},
			}
			backend, err := newS3CompatibleBackend(client, "pages-prod")
			if err != nil {
				t.Fatalf("newS3CompatibleBackend() error = %v", err)
			}

			_, gotErr := backend.HeadObject(context.Background(), key)
			if errors.Is(gotErr, ErrObjectNotFound) != test.wantNotFound {
				t.Errorf("HeadObject() ErrObjectNotFound = %v, want %v (error: %v)", errors.Is(gotErr, ErrObjectNotFound), test.wantNotFound, gotErr)
			}
			if test.wantSameHeadErr && !errors.Is(gotErr, test.headError) {
				t.Errorf("HeadObject() error %v does not preserve the original HEAD error %v", gotErr, test.headError)
			}
			if test.name == "exact key is listed" && gotErr != test.headError {
				t.Errorf("HeadObject() error = %v, want the original HEAD error %v", gotErr, test.headError)
			}
			if test.wantListErrorMsg != "" && !strings.Contains(gotErr.Error(), test.wantListErrorMsg) {
				t.Errorf("HeadObject() error = %v, want list confirmation context %q", gotErr, test.wantListErrorMsg)
			}
			if test.wantListErr && !errors.Is(gotErr, test.listError) {
				t.Errorf("HeadObject() error %v does not preserve the list confirmation error %v", gotErr, test.listError)
			}
			if listCalls != test.wantListCalls {
				t.Fatalf("ListObjectsV2 calls = %d, want %d", listCalls, test.wantListCalls)
			}
			if listCalls > 0 && listPrefix != key {
				t.Errorf("confirmation Prefix = %q, want exact key %q", listPrefix, key)
			}
		})
	}
}
