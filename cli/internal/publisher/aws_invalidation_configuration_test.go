package publisher

import (
	"context"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
)

type awsInvalidationConfigurationTestClient struct {
	calls int
}

func (client *awsInvalidationConfigurationTestClient) CreateInvalidation(_ context.Context, _ *cloudfront.CreateInvalidationInput, _ ...func(*cloudfront.Options)) (*cloudfront.CreateInvalidationOutput, error) {
	client.calls++
	return nil, nil
}

func TestAWSInvalidateSkipsWhenDistributionIDIsNotConfigured(t *testing.T) {
	for _, test := range []struct {
		name           string
		distributionID string
	}{
		{name: "unset"},
		{name: "whitespace", distributionID: " \t"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &awsInvalidationConfigurationTestClient{}
			backend := &awsBackend{cloudFront: client, distributionID: test.distributionID}

			if _, err := backend.Invalidate(context.Background(), []string{"/_indexes/sites.json"}); err != nil {
				t.Fatalf("Invalidate() error = %v, want no-op without CloudFront target", err)
			}
			if client.calls != 0 {
				t.Fatalf("CreateInvalidation() calls = %d, want 0 without a distribution ID", client.calls)
			}
		})
	}
}

func TestAWSInvalidateRequiresClientForRequestedPaths(t *testing.T) {
	backend := &awsBackend{distributionID: "E123EXAMPLE"}

	_, err := backend.Invalidate(context.Background(), []string{"/_indexes/sites.json"})
	if err == nil || !strings.Contains(err.Error(), "CloudFront client is required") {
		t.Fatalf("Invalidate() error = %v, want missing-client error", err)
	}
}

func TestAWSInvalidateAllowsEmptyPathListWithoutCloudFrontConfiguration(t *testing.T) {
	backend := &awsBackend{}

	if _, err := backend.Invalidate(context.Background(), nil); err != nil {
		t.Fatalf("Invalidate(empty paths) error = %v, want no-op", err)
	}
}
