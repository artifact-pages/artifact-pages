package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const cloudflareAPIBase = "https://api.cloudflare.com/client/v4"

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
	zoneID         string
	baseURL        *url.URL
	apiToken       string
	apiTokenSource func() string
	apiBaseURL     string
	httpClient     *http.Client
}

var _ DeploymentBackend = (*cloudflareBackend)(nil)
var _ ConditionalObjectBackend = (*cloudflareBackend)(nil)

// NewCloudflareBackend uses R2's S3-compatible API for objects and locks, and
// the zone cache API for revalidation. Those differences remain inside this
// provider adapter; site reconciliation uses the same DeploymentBackend.
func NewCloudflareBackend(ctx context.Context, options CloudflareOptions) (DeploymentBackend, error) {
	if strings.TrimSpace(options.AccountID) == "" || strings.TrimSpace(options.Bucket) == "" || strings.TrimSpace(options.ZoneID) == "" ||
		strings.TrimSpace(options.AccessKeyID) == "" || strings.TrimSpace(options.SecretKey) == "" {
		return nil, errors.New("Cloudflare account, bucket, zone, and R2 credentials are required")
	}
	registryReaderConfigured := options.RegistryReaderAccessKeyID != "" || options.RegistryReaderSecretKey != "" || options.RegistryReaderSessionToken != ""
	if registryReaderConfigured && (strings.TrimSpace(options.RegistryReaderAccessKeyID) == "" || strings.TrimSpace(options.RegistryReaderSecretKey) == "") {
		return nil, errors.New("Cloudflare registry reader access key ID and secret are required together")
	}
	if !cloudflareIdentifierPattern.MatchString(options.AccountID) || !cloudflareIdentifierPattern.MatchString(options.ZoneID) {
		return nil, errors.New("Cloudflare account and zone IDs must be 32-character hexadecimal IDs")
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
	apiBaseURL := cloudflareAPIBase
	if options.APIBaseURL != "" {
		apiBaseURL = strings.TrimRight(options.APIBaseURL, "/")
	}
	return &cloudflareBackend{
		objects: objects, registryReader: registryReader, zoneID: options.ZoneID, baseURL: baseURL,
		apiToken: options.APIToken, apiTokenSource: options.APITokenProvider, apiBaseURL: apiBaseURL,
		httpClient: &http.Client{Timeout: 20 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

func newCloudflareObjectBackend(ctx context.Context, endpoint, bucket, accessKeyID, secretKey, sessionToken string) (*s3CompatibleBackend, error) {
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion("auto"),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(accessKeyID, secretKey, sessionToken)),
	)
	if err != nil {
		return nil, fmt.Errorf("load R2 client configuration: %w", err)
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
	if key == "_indexes/sites.json" && backend.registryReader != nil {
		return backend.registryReader.GetObject(ctx, key)
	}
	return backend.objects.GetObject(ctx, key)
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

func (backend *cloudflareBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	for _, rawPath := range paths {
		if !validCloudflareInvalidationPath(rawPath) {
			return "", fmt.Errorf("invalid cache path %q", rawPath)
		}
	}
	paths = backend.PlanInvalidation(paths)
	if err := backend.ValidateInvalidation(paths); err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", nil
	}
	var prefixes, files []string
	for _, rawPath := range paths {
		if strings.HasSuffix(rawPath, "/*") {
			prefixPath := strings.TrimSuffix(rawPath, "*")
			prefixes = append(prefixes, backend.baseURL.Host+prefixPath)
			continue
		}
		files = append(files, backend.baseURL.Scheme+"://"+backend.baseURL.Host+rawPath)
	}
	sort.Strings(prefixes)
	sort.Strings(files)
	var identifiers []string
	for start := 0; start < len(prefixes); start += 100 {
		end := min(start+100, len(prefixes))
		id, err := backend.purge(ctx, map[string][]string{"prefixes": prefixes[start:end]})
		if err != nil {
			return strings.Join(identifiers, ","), err
		}
		if id != "" {
			identifiers = append(identifiers, id)
		}
	}
	for start := 0; start < len(files); start += 100 {
		end := min(start+100, len(files))
		id, err := backend.purge(ctx, map[string][]string{"files": files[start:end]})
		if err != nil {
			return strings.Join(identifiers, ","), err
		}
		if id != "" {
			identifiers = append(identifiers, id)
		}
	}
	return strings.Join(identifiers, ","), nil
}

func (backend *cloudflareBackend) PlanInvalidation(paths []string) []string {
	return cloudflareSiteInvalidationPaths(paths)
}

const cloudflareExactSiteInvalidationLimit = 100

func validCloudflareInvalidationPath(rawPath string) bool {
	return strings.HasPrefix(rawPath, "/") && !strings.ContainsAny(rawPath, "?#") &&
		(!strings.Contains(rawPath, "*") || strings.HasSuffix(rawPath, "/*"))
}

// cloudflareSiteInvalidationPaths bounds purge API calls for large site
// publishes while keeping every compacted path inside the selected site's
// artifact or index prefix. Cloudflare accepts URL-prefix purges; the retry
// record continues to store the original exact paths.
func cloudflareSiteInvalidationPaths(paths []string) []string {
	counts := make(map[string]map[string]struct{})
	for _, rawPath := range paths {
		if !validCloudflareInvalidationPath(rawPath) {
			continue
		}
		prefix := cloudflareSiteInvalidationPrefix(rawPath)
		if prefix == "" || strings.HasSuffix(rawPath, "/*") {
			continue
		}
		if counts[prefix] == nil {
			counts[prefix] = make(map[string]struct{})
		}
		counts[prefix][rawPath] = struct{}{}
	}
	compact := make(map[string]bool, len(counts))
	for prefix, uniquePaths := range counts {
		compact[prefix] = len(uniquePaths) > cloudflareExactSiteInvalidationLimit
	}
	set := make(map[string]struct{}, len(paths))
	for _, rawPath := range paths {
		if !validCloudflareInvalidationPath(rawPath) {
			set[rawPath] = struct{}{}
			continue
		}
		if prefix := cloudflareSiteInvalidationPrefix(rawPath); compact[prefix] {
			set[prefix+"*"] = struct{}{}
			continue
		}
		set[rawPath] = struct{}{}
	}
	result := make([]string, 0, len(set))
	for rawPath := range set {
		result = append(result, rawPath)
	}
	sort.Strings(result)
	return result
}

func cloudflareSiteInvalidationPrefix(rawPath string) string {
	var keyPrefix string
	switch {
	case strings.HasPrefix(rawPath, "/_artifacts/"):
		keyPrefix = "/_artifacts/"
	case strings.HasPrefix(rawPath, "/_indexes/"):
		keyPrefix = "/_indexes/"
	default:
		return ""
	}
	parts := strings.SplitN(strings.TrimPrefix(rawPath, keyPrefix), "/", 2)
	if len(parts) != 2 || validateLockSite(parts[0]) != nil {
		return ""
	}
	return keyPrefix + parts[0] + "/"
}

func (backend *cloudflareBackend) ValidateInvalidation(paths []string) error {
	if len(paths) > 0 && strings.TrimSpace(backend.currentAPIToken()) == "" {
		return errors.New("Cloudflare API token is required for cache invalidation")
	}
	return nil
}

func (backend *cloudflareBackend) currentAPIToken() string {
	if backend.apiTokenSource != nil {
		return backend.apiTokenSource()
	}
	return backend.apiToken
}

func (backend *cloudflareBackend) purge(ctx context.Context, body any) (string, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("encode Cloudflare cache purge request: %w", err)
	}
	apiBaseURL := backend.apiBaseURL
	if apiBaseURL == "" {
		apiBaseURL = cloudflareAPIBase
	}
	endpoint := apiBaseURL + "/zones/" + url.PathEscape(backend.zoneID) + "/purge_cache"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return "", errors.New("create Cloudflare cache purge request")
	}
	request.Header.Set("Authorization", "Bearer "+backend.currentAPIToken())
	request.Header.Set("Content-Type", "application/json")
	response, err := backend.httpClient.Do(request)
	if err != nil {
		return "", errors.New("Cloudflare cache purge request failed")
	}
	defer response.Body.Close()
	contents, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return "", errors.New("read Cloudflare cache purge response")
	}
	var result struct {
		Success bool `json:"success"`
		Errors  []struct {
			Code             json.RawMessage `json:"code"`
			Message          string          `json:"message"`
			DocumentationURL string          `json:"documentation_url"`
		} `json:"errors"`
		Result struct {
			ID string `json:"id"`
		} `json:"result"`
	}
	decodeErr := json.Unmarshal(contents, &result)
	if response.StatusCode < 200 || response.StatusCode >= 300 || decodeErr != nil || !result.Success {
		requestContext := fmt.Sprintf("POST /zones/%s/purge_cache for zone %s (HTTP %d)", backend.zoneID, backend.zoneID, response.StatusCode)
		switch {
		case len(result.Errors) > 0:
			return "", fmt.Errorf("Cloudflare cache purge request %s failed: %s", requestContext, formatCloudflareAPIErrors(result.Errors))
		case decodeErr != nil:
			return "", fmt.Errorf("Cloudflare cache purge request %s returned an invalid API response: %w", requestContext, decodeErr)
		default:
			return "", fmt.Errorf("Cloudflare cache purge request %s failed: API returned success=false without error details", requestContext)
		}
	}
	return result.Result.ID, nil
}

func formatCloudflareAPIErrors(apiErrors []struct {
	Code             json.RawMessage `json:"code"`
	Message          string          `json:"message"`
	DocumentationURL string          `json:"documentation_url"`
}) string {
	details := make([]string, 0, len(apiErrors))
	for _, apiError := range apiErrors {
		parts := make([]string, 0, 3)
		if code := strings.TrimSpace(string(apiError.Code)); code != "" && code != "null" {
			parts = append(parts, "code "+code)
		}
		if message := strings.TrimSpace(apiError.Message); message != "" {
			parts = append(parts, message)
		}
		if documentationURL := strings.TrimSpace(apiError.DocumentationURL); documentationURL != "" {
			parts = append(parts, "documentation: "+documentationURL)
		}
		if len(parts) == 0 {
			parts = append(parts, "unspecified API error")
		}
		details = append(details, strings.Join(parts, ": "))
	}
	return strings.Join(details, "; ")
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
