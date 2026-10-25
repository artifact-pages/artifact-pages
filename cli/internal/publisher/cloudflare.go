package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/retry"
	awshttp "github.com/aws/aws-sdk-go-v2/aws/transport/http"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const cloudflareAPIBase = "https://api.cloudflare.com/client/v4"
const cloudflareTokenVerificationResponseLimit = 1 << 20

var cloudflareIdentifierPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

type CloudflareOptions struct {
	AccountID                  string
	Bucket                     string
	ZoneID                     string
	PublicBaseURL              string
	R2Endpoint                 string
	APIBaseURL                 string
	AccessKeyID                string
	SecretKey                  string
	SessionToken               string
	RegistryReaderAccessKeyID  string
	RegistryReaderSecretKey    string
	RegistryReaderSessionToken string
	APIToken                   string
	APITokenProvider           func() string
}

type cloudflareBackend struct {
	objects        *s3CompatibleBackend
	registryReader *s3CompatibleBackend
}

var _ DeploymentBackend = (*cloudflareBackend)(nil)
var _ ConditionalObjectBackend = (*cloudflareBackend)(nil)

// NewCloudflareBackend uses R2's S3-compatible API for objects and locks, and
// the zone cache API for revalidation. Those differences remain inside this
// provider adapter; site reconciliation uses the same DeploymentBackend.
func NewCloudflareBackend(ctx context.Context, options CloudflareOptions) (DeploymentBackend, error) {
	if strings.TrimSpace(options.AccountID) == "" || strings.TrimSpace(options.Bucket) == "" || strings.TrimSpace(options.ZoneID) == "" {
		return nil, errors.New("Cloudflare account, bucket, zone, and R2 credentials are required")
	}
	accessKeyIDPresent := strings.TrimSpace(options.AccessKeyID) != ""
	secretKeyPresent := strings.TrimSpace(options.SecretKey) != ""
	if accessKeyIDPresent != secretKeyPresent {
		return nil, errors.New("Cloudflare R2 access key ID and secret must be set together")
	}
	explicitR2Credentials := accessKeyIDPresent && secretKeyPresent
	if !explicitR2Credentials && strings.TrimSpace(options.SessionToken) != "" {
		return nil, errors.New("Cloudflare R2 session token requires an explicit access key ID and secret")
	}
	registryReaderConfigured := options.RegistryReaderAccessKeyID != "" || options.RegistryReaderSecretKey != "" || options.RegistryReaderSessionToken != ""
	if registryReaderConfigured && (strings.TrimSpace(options.RegistryReaderAccessKeyID) == "" || strings.TrimSpace(options.RegistryReaderSecretKey) == "") {
		return nil, errors.New("Cloudflare registry reader access key ID and secret are required together")
	}
	if !cloudflareIdentifierPattern.MatchString(options.ZoneID) {
		return nil, errors.New("Cloudflare zone ID must be a 32-character hexadecimal ID")
	}
	if !cloudflareIdentifierPattern.MatchString(options.AccountID) {
		return nil, errors.New("Cloudflare account ID must be a 32-character hexadecimal ID")
	}
	if (options.R2Endpoint == "") != (options.APIBaseURL == "") {
		return nil, errors.New("Cloudflare R2 and API endpoints must be configured together")
	}
	if options.R2Endpoint != "" {
		if err := validateLocalEndpoint(options.R2Endpoint, false); err != nil {
			return nil, fmt.Errorf("Cloudflare R2 endpoint: %w", err)
		}
		if err := validateLocalEndpoint(options.APIBaseURL, true); err != nil {
			return nil, fmt.Errorf("Cloudflare API base URL: %w", err)
		}
	}
	baseURL, err := url.Parse(options.PublicBaseURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" || (baseURL.Path != "" && baseURL.Path != "/") {
		return nil, errors.New("Cloudflare public base URL must be an HTTPS origin")
	}
	apiBaseURL := cloudflareAPIBase
	if options.APIBaseURL != "" {
		apiBaseURL = strings.TrimRight(options.APIBaseURL, "/")
	}
	httpClient := &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	if !explicitR2Credentials {
		apiToken := options.APIToken
		if options.APITokenProvider != nil {
			apiToken = options.APITokenProvider()
		}
		if strings.TrimSpace(apiToken) == "" {
			return nil, errors.New("Cloudflare API token is required to derive R2 credentials")
		}
		var err error
		options.AccessKeyID, options.SecretKey, err = deriveCloudflareR2Credentials(ctx, httpClient, apiBaseURL, options.AccountID, apiToken)
		if err != nil {
			return nil, err
		}
	}
	endpoint := options.R2Endpoint
	if endpoint == "" {
		endpoint = "https://" + options.AccountID + ".r2.cloudflarestorage.com"
	}
	objects, err := newCloudflareObjectBackend(ctx, endpoint, options.Bucket, options.AccessKeyID, options.SecretKey, options.SessionToken)
	if err != nil {
		return nil, fmt.Errorf("configure Cloudflare R2 object backend: %w", err)
	}
	var registryReader *s3CompatibleBackend
	if registryReaderConfigured {
		registryReader, err = newCloudflareObjectBackend(ctx, endpoint, options.Bucket, options.RegistryReaderAccessKeyID, options.RegistryReaderSecretKey, options.RegistryReaderSessionToken)
		if err != nil {
			return nil, fmt.Errorf("configure Cloudflare R2 registry reader: %w", err)
		}
	}
	return &cloudflareBackend{objects: objects, registryReader: registryReader}, nil
}

func deriveCloudflareR2Credentials(ctx context.Context, client *http.Client, apiBaseURL, accountID, apiToken string) (string, string, error) {
	endpoint := strings.TrimRight(apiBaseURL, "/") + "/accounts/" + url.PathEscape(accountID) + "/tokens/verify"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", "", errors.New("create Cloudflare API token verification request")
	}
	request.Header.Set("Authorization", "Bearer "+apiToken)
	response, err := client.Do(request)
	if err != nil {
		switch {
		case errors.Is(err, context.Canceled):
			return "", "", errors.New("Cloudflare API token verification was canceled")
		case errors.Is(err, context.DeadlineExceeded):
			return "", "", errors.New("Cloudflare API token verification timed out")
		default:
			return "", "", errors.New("Cloudflare API token verification request failed")
		}
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return "", "", fmt.Errorf("Cloudflare API token verification failed (HTTP %d)", response.StatusCode)
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, cloudflareTokenVerificationResponseLimit+1))
	if err != nil {
		return "", "", fmt.Errorf("read Cloudflare API token verification response (HTTP %d)", response.StatusCode)
	}
	if len(contents) > cloudflareTokenVerificationResponseLimit {
		return "", "", fmt.Errorf("Cloudflare API token verification response is too large (HTTP %d)", response.StatusCode)
	}
	var result struct {
		Success bool `json:"success"`
		Result  struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"result"`
	}
	if err := json.Unmarshal(contents, &result); err != nil {
		return "", "", fmt.Errorf("Cloudflare API token verification returned an invalid response (HTTP %d)", response.StatusCode)
	}
	if !result.Success || result.Result.Status != "active" || !cloudflareIdentifierPattern.MatchString(result.Result.ID) {
		return "", "", fmt.Errorf("Cloudflare API token verification did not return an active token ID (HTTP %d)", response.StatusCode)
	}
	secret := sha256.Sum256([]byte(apiToken))
	return result.Result.ID, hex.EncodeToString(secret[:]), nil
}

// cloudflareRetryMaxAttempts is the total attempt count (first try included) for
// R2 requests. It is a variable so tests can make an injected 5xx visible.
var cloudflareRetryMaxAttempts = 3

func newCloudflareObjectBackend(_ context.Context, endpoint, bucket, accessKeyID, secretKey, sessionToken string) (*s3CompatibleBackend, error) {
	// R2 depends only on the deployment config and the named credential
	// variables. Build the aws.Config directly instead of config.LoadDefaultConfig,
	// which would also read ~/.aws/*, AWS_PROFILE, AWS_CA_BUNDLE, AWS_ENDPOINT_URL*,
	// AWS_MAX_ATTEMPTS and similar settings meant for AWS. Retry and HTTP behavior
	// are explicit so they no longer come from the machine's AWS environment.
	cfg := aws.Config{
		Region:           "auto",
		Credentials:      credentials.NewStaticCredentialsProvider(accessKeyID, secretKey, sessionToken),
		HTTPClient:       awshttp.NewBuildableClient(),
		RetryMaxAttempts: cloudflareRetryMaxAttempts,
		Retryer: func() aws.Retryer {
			return retry.NewStandard(func(options *retry.StandardOptions) { options.MaxAttempts = cloudflareRetryMaxAttempts })
		},
	}
	client := s3.NewFromConfig(cfg, func(serviceOptions *s3.Options) {
		serviceOptions.BaseEndpoint = aws.String(endpoint)
		serviceOptions.UsePathStyle = true
	})
	return newS3CompatibleBackend(client, bucket)
}

func (backend *cloudflareBackend) PutObject(ctx context.Context, key string, object Object) error {
	return backend.objects.PutObject(ctx, key, object)
}

func (backend *cloudflareBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	if (key == "_indexes/sites.json" || key == appVersionsKey) && backend.registryReader != nil {
		return backend.registryReader.GetObject(ctx, key)
	}
	return backend.objects.GetObject(ctx, key)
}

func (*cloudflareBackend) publishStateReadMode() publishStateReadMode {
	return publishStateReadGetOnly
}

func (backend *cloudflareBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	return backend.objects.HeadObject(ctx, key)
}

func (backend *cloudflareBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	return backend.objects.PutObjectConditional(ctx, key, object, condition)
}

func (backend *cloudflareBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	return backend.objects.ListKeys(ctx, prefix)
}

func (backend *cloudflareBackend) DeleteObjects(ctx context.Context, keys []string) error {
	return backend.objects.DeleteObjects(ctx, keys)
}

func validateLocalEndpoint(raw string, allowPath bool) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return errors.New("must be an HTTP loopback endpoint without credentials, query, or fragment")
	}
	if parsed.Hostname() != "localhost" {
		ip := net.ParseIP(parsed.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return errors.New("must be an HTTP loopback endpoint without credentials, query, or fragment")
		}
	}
	if !allowPath && parsed.Path != "" && parsed.Path != "/" {
		return errors.New("must be an HTTP loopback origin without a path")
	}
	return nil
}
