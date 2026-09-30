package publisher

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	cloudfronttypes "github.com/aws/aws-sdk-go-v2/service/cloudfront/types"
)

type awsInvalidationTestCloudFront struct {
	input  *cloudfront.CreateInvalidationInput
	output *cloudfront.CreateInvalidationOutput
	err    error
}

func (client *awsInvalidationTestCloudFront) CreateInvalidation(_ context.Context, input *cloudfront.CreateInvalidationInput, _ ...func(*cloudfront.Options)) (*cloudfront.CreateInvalidationOutput, error) {
	client.input = input
	return client.output, client.err
}

func TestAWSInvalidateBuildsCloudFrontRequestAndReturnsInvalidationID(t *testing.T) {
	const distributionID = "E123EXAMPLE"
	paths := []string{"/_indexes/sites.json", "/sre", "/sre/*", "/_previews/sre/*"}
	client := &awsInvalidationTestCloudFront{
		output: &cloudfront.CreateInvalidationOutput{
			Invalidation: &cloudfronttypes.Invalidation{Id: aws.String("I123INVALIDATION")},
		},
	}
	backend := &awsBackend{cloudFront: client, distributionID: distributionID}

	invalidationID, err := backend.Invalidate(context.Background(), paths)
	if err != nil {
		t.Fatalf("Invalidate() error = %v", err)
	}
	if invalidationID != "I123INVALIDATION" {
		t.Fatalf("Invalidate() ID = %q, want I123INVALIDATION", invalidationID)
	}
	if client.input == nil {
		t.Fatal("CreateInvalidation() was not called")
	}
	if got := aws.ToString(client.input.DistributionId); got != distributionID {
		t.Errorf("DistributionId = %q, want %q", got, distributionID)
	}
	batch := client.input.InvalidationBatch
	if batch == nil || batch.Paths == nil {
		t.Fatal("CreateInvalidation() did not receive an invalidation batch and paths")
	}
	if got := aws.ToInt32(batch.Paths.Quantity); got != int32(len(paths)) {
		t.Errorf("Paths.Quantity = %d, want %d", got, len(paths))
	}
	if !reflect.DeepEqual(batch.Paths.Items, paths) {
		t.Errorf("Paths.Items = %v, want %v", batch.Paths.Items, paths)
	}
	if aws.ToString(batch.CallerReference) == "" {
		t.Error("CallerReference is empty")
	}
}

func TestAWSInvalidateWrapsCloudFrontRequestFailureAndReturnsNoID(t *testing.T) {
	const distributionID = "E123EXAMPLE"
	apiErr := errors.New("CloudFront rejected the invalidation")
	client := &awsInvalidationTestCloudFront{err: apiErr}
	backend := &awsBackend{cloudFront: client, distributionID: distributionID}

	invalidationID, err := backend.Invalidate(context.Background(), []string{"/_indexes/sites.json", "/sre/*"})
	if invalidationID != "" {
		t.Errorf("Invalidate() ID = %q, want empty ID on API failure", invalidationID)
	}
	if err == nil {
		t.Fatal("Invalidate() error = nil, want CloudFront API failure")
	}
	if !errors.Is(err, apiErr) {
		t.Errorf("Invalidate() error = %v, want wrapped CloudFront API error", err)
	}
	if !strings.Contains(err.Error(), distributionID) {
		t.Errorf("Invalidate() error = %q, want distribution ID %q", err, distributionID)
	}
	if client.input == nil {
		t.Fatal("CreateInvalidation() was not called")
	}
}

func TestAWSInvalidateReturnsEmptyIDWhenCloudFrontOmitsInvalidation(t *testing.T) {
	client := &awsInvalidationTestCloudFront{}
	backend := &awsBackend{cloudFront: client, distributionID: "E123EXAMPLE"}

	invalidationID, err := backend.Invalidate(context.Background(), []string{"/index.html"})
	if err != nil {
		t.Fatalf("Invalidate() error = %v", err)
	}
	if invalidationID != "" {
		t.Errorf("Invalidate() ID = %q, want empty ID when response omits invalidation", invalidationID)
	}
}
