package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestCloudflareInvalidateTranslatesURLsAndPrefixes(t *testing.T) {
	type purgeRequest struct {
		method        string
		path          string
		authorization string
		contentType   string
		body          map[string][]string
	}
	var requests []purgeRequest
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string][]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode purge body: %v", err)
		}
		requests = append(requests, purgeRequest{
			method: request.Method, path: request.URL.Path,
			authorization: request.Header.Get("Authorization"),
			contentType:   request.Header.Get("Content-Type"), body: body,
		})
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"success":true,"result":{"id":"purge-%d"}}`, len(requests))
	}))
	defer server.Close()

	backend := cloudflareBackendForTest(server)
	id, err := backend.Invalidate(context.Background(), []string{
		"/_previews/sre/*",
		"/_indexes/sites.json",
		"/_artifacts/sre/reports/weekly.html",
		"/_indexes/sre/*",
	})
	if err != nil {
		t.Fatalf("Invalidate() error = %v", err)
	}
	if id != "purge-1,purge-2" {
		t.Fatalf("Invalidate() ID = %q, want purge-1,purge-2", id)
	}
	if len(requests) != 2 {
		t.Fatalf("purge requests = %d, want separate prefix and URL requests", len(requests))
	}
	for _, request := range requests {
		if request.method != http.MethodPost || request.path != "/client/v4/zones/0123456789abcdef0123456789abcdef/purge_cache" {
			t.Errorf("request target = %s %s, want POST to the zone purge endpoint", request.method, request.path)
		}
		if request.authorization != "Bearer test-api-token" {
			t.Errorf("Authorization = %q, want configured bearer token", request.authorization)
		}
		if request.contentType != "application/json" {
			t.Errorf("Content-Type = %q, want application/json", request.contentType)
		}
	}
	if got, want := requests[0].body, map[string][]string{
		"prefixes": {
			"pages.example.com/_indexes/sre/",
			"pages.example.com/_previews/sre/",
		},
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("prefix purge body = %#v, want %#v", got, want)
	}
	if got, want := requests[1].body, map[string][]string{
		"files": {
			"https://pages.example.com/_artifacts/sre/reports/weekly.html",
			"https://pages.example.com/_indexes/sites.json",
		},
	}; !reflect.DeepEqual(got, want) {
		t.Errorf("URL purge body = %#v, want %#v", got, want)
	}
}

func TestCloudflareInvalidateBatchesAtAPIItemLimit(t *testing.T) {
	var batches []map[string][]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string][]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode purge body: %v", err)
		}
		for key, values := range body {
			if len(values) > 100 {
				t.Errorf("%s batch has %d entries, exceeds Cloudflare's 100-entry request limit", key, len(values))
			}
		}
		batches = append(batches, body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"success":true,"result":{"id":"purge-%d"}}`, len(batches))
	}))
	defer server.Close()

	paths := make([]string, 0, 202)
	for index := 0; index < 101; index++ {
		paths = append(paths, fmt.Sprintf("/_artifacts/site-%03d/*", index))
	}
	for index := 0; index < 101; index++ {
		paths = append(paths, fmt.Sprintf("/_indexes/site-%03d/meta.json", index))
	}
	backend := cloudflareBackendForTest(server)
	id, err := backend.Invalidate(context.Background(), paths)
	if err != nil {
		t.Fatalf("Invalidate() error = %v", err)
	}
	if id != "purge-1,purge-2,purge-3,purge-4" {
		t.Fatalf("Invalidate() IDs = %q, want IDs for four ordered batches", id)
	}
	if len(batches) != 4 {
		t.Fatalf("purge requests = %d, want 4", len(batches))
	}
	wantSizes := []int{100, 1, 100, 1}
	wantKinds := []string{"prefixes", "prefixes", "files", "files"}
	for index, batch := range batches {
		if len(batch) != 1 {
			t.Errorf("batch %d contains fields %v, want only %q", index+1, batch, wantKinds[index])
			continue
		}
		if got := len(batch[wantKinds[index]]); got != wantSizes[index] {
			t.Errorf("batch %d %s count = %d, want %d", index+1, wantKinds[index], got, wantSizes[index])
		}
	}
}

func TestCloudflareInvalidateCompactsLargeSitePlansToOwnedPrefixes(t *testing.T) {
	var batches []map[string][]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string][]string
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Errorf("decode purge body: %v", err)
		}
		batches = append(batches, body)
		writer.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(writer, `{"success":true,"result":{"id":"purge-%d"}}`, len(batches))
	}))
	defer server.Close()

	paths := []string{"/_indexes/sites.json", "/_artifacts/neighbor/keep.html", "/_previews/sre/catalog.json", "/assets/index-123.js"}
	for index := 0; index < cloudflareExactSiteInvalidationLimit+1; index++ {
		paths = append(paths,
			fmt.Sprintf("/_artifacts/sre/pages/%03d.html", index),
			fmt.Sprintf("/_indexes/sre/search/leaf-%03d.gz", index),
		)
	}
	backend := cloudflareBackendForTest(server)
	wantPlan := []string{"/_artifacts/neighbor/keep.html", "/_artifacts/sre/*", "/_indexes/sites.json", "/_indexes/sre/*", "/_previews/sre/catalog.json", "/assets/index-123.js"}
	if got := backend.PlanInvalidation(paths); !reflect.DeepEqual(got, wantPlan) {
		t.Fatalf("PlanInvalidation() = %v, want site-scoped compact plan %v", got, wantPlan)
	}
	id, err := backend.Invalidate(context.Background(), paths)
	if err != nil {
		t.Fatalf("Invalidate() error = %v", err)
	}
	if id != "purge-1,purge-2" || len(batches) != 2 {
		t.Fatalf("Invalidate() = id %q with %d requests, want two bounded requests", id, len(batches))
	}
	if got, want := batches[0], map[string][]string{"prefixes": {"pages.example.com/_artifacts/sre/", "pages.example.com/_indexes/sre/"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("prefix purge body = %#v, want %#v", got, want)
	}
	if got, want := batches[1], map[string][]string{"files": {"https://pages.example.com/_artifacts/neighbor/keep.html", "https://pages.example.com/_indexes/sites.json", "https://pages.example.com/_previews/sre/catalog.json", "https://pages.example.com/assets/index-123.js"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("exact purge body = %#v, want %#v", got, want)
	}
}

func TestCloudflareSiteInvalidationThresholdCountsUniquePathsPerOwnedPrefix(t *testing.T) {
	for _, test := range []struct {
		name       string
		count      int
		duplicates bool
		wantCount  int
		wantFirst  string
	}{
		{name: "at exact URL limit", count: cloudflareExactSiteInvalidationLimit, wantCount: cloudflareExactSiteInvalidationLimit, wantFirst: "/_artifacts/sre/pages/000.html"},
		{name: "above exact URL limit", count: cloudflareExactSiteInvalidationLimit + 1, wantCount: 1, wantFirst: "/_artifacts/sre/*"},
		{name: "duplicate exact URLs do not trigger prefix", count: cloudflareExactSiteInvalidationLimit + 1, duplicates: true, wantCount: 1, wantFirst: "/_artifacts/sre/pages/000.html"},
	} {
		t.Run(test.name, func(t *testing.T) {
			paths := make([]string, 0, test.count)
			for index := 0; index < test.count; index++ {
				path := fmt.Sprintf("/_artifacts/sre/pages/%03d.html", index)
				if test.duplicates {
					path = "/_artifacts/sre/pages/000.html"
				}
				paths = append(paths, path)
			}
			got := cloudflareSiteInvalidationPaths(paths)
			if len(got) != test.wantCount || got[0] != test.wantFirst {
				t.Fatalf("planned path count/first = %d/%q, want %d/%q", len(got), got[0], test.wantCount, test.wantFirst)
			}
		})
	}
}

func TestCloudflareInvalidateRejectsMalformedLargePathsBeforeCompaction(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"success":true,"result":{"id":"unused"}}`))
	}))
	defer server.Close()

	paths := make([]string, cloudflareExactSiteInvalidationLimit+1)
	for index := range paths {
		paths[index] = fmt.Sprintf("/_artifacts/sre/pages/%03d.html?cache=%d", index, index)
	}
	if _, err := cloudflareBackendForTest(server).Invalidate(context.Background(), paths); err == nil || !strings.Contains(err.Error(), "invalid cache path") {
		t.Fatalf("Invalidate(malformed large plan) error = %v, want invalid-path error", err)
	}
	if calls != 0 {
		t.Fatalf("purge requests = %d, want no API requests for malformed paths", calls)
	}

	validAndInvalid := make([]string, 0, cloudflareExactSiteInvalidationLimit+2)
	for index := 0; index < cloudflareExactSiteInvalidationLimit+1; index++ {
		validAndInvalid = append(validAndInvalid, fmt.Sprintf("/_artifacts/sre/pages/%03d.html", index))
	}
	invalid := "/_artifacts/sre/invalid.html?bad=1"
	validAndInvalid = append(validAndInvalid, invalid)
	wantPlan := []string{"/_artifacts/sre/*", invalid}
	if got := cloudflareSiteInvalidationPaths(validAndInvalid); !reflect.DeepEqual(got, wantPlan) {
		t.Fatalf("planned paths hid malformed input: got %v, want %v", got, wantPlan)
	}
}

func TestCloudflareInvalidateReportsAPIAndTransportFailures(t *testing.T) {
	t.Run("HTTP failure", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			http.Error(writer, `{"success":false}`, http.StatusForbidden)
		}))
		defer server.Close()

		_, err := cloudflareBackendForTest(server).Invalidate(context.Background(), []string{"/sre/*"})
		if err == nil || !strings.Contains(err.Error(), "HTTP 403") {
			t.Fatalf("Invalidate() error = %v, want HTTP 403 failure", err)
		}
	})

	t.Run("API reports unsuccessful result with provider details", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"success":false,"errors":[{"code":10000,"message":"Rate limit exceeded","documentation_url":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-10000/"}]}`))
		}))
		defer server.Close()

		_, err := cloudflareBackendForTest(server).Invalidate(context.Background(), []string{"/sre/*"})
		if err == nil {
			t.Fatal("Invalidate() error = nil, want unsuccessful API response")
		}
		for _, want := range []string{
			"POST /zones/0123456789abcdef0123456789abcdef/purge_cache",
			"zone 0123456789abcdef0123456789abcdef",
			"HTTP 200",
			"code 10000",
			"Rate limit exceeded",
			"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-10000/",
		} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("Invalidate() error = %q, want it to include %q", err, want)
			}
		}
	})

	t.Run("HTTP rate limit preserves provider details", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"success":false,"errors":[{"code":1015,"message":"You are being rate limited"}]}`))
		}))
		defer server.Close()

		_, err := cloudflareBackendForTest(server).Invalidate(context.Background(), []string{"/sre/*"})
		if err == nil {
			t.Fatal("Invalidate() error = nil, want HTTP rate-limit failure")
		}
		for _, want := range []string{"HTTP 429", "code 1015", "You are being rate limited"} {
			if !strings.Contains(err.Error(), want) {
				t.Errorf("Invalidate() error = %q, want it to include %q", err, want)
			}
		}
	})

	t.Run("later batch failure returns earlier purge ID", func(t *testing.T) {
		calls := 0
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			calls++
			writer.Header().Set("Content-Type", "application/json")
			if calls == 1 {
				_, _ = writer.Write([]byte(`{"success":true,"result":{"id":"purge-first"}}`))
				return
			}
			writer.WriteHeader(http.StatusTooManyRequests)
			_, _ = writer.Write([]byte(`{"success":false}`))
		}))
		defer server.Close()

		paths := make([]string, 101)
		for index := range paths {
			paths[index] = fmt.Sprintf("/site-%03d/*", index)
		}
		id, err := cloudflareBackendForTest(server).Invalidate(context.Background(), paths)
		if err == nil || !strings.Contains(err.Error(), "HTTP 429") {
			t.Fatalf("Invalidate() error = %v, want second-batch HTTP 429", err)
		}
		if id != "purge-first" || calls != 2 {
			t.Fatalf("Invalidate() = ID %q after %d requests, want first ID and stopped second-batch failure", id, calls)
		}
	})

	t.Run("transport failure", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"success":true,"result":{"id":"unused"}}`))
		}))
		server.Close()

		_, err := cloudflareBackendForTest(server).Invalidate(context.Background(), []string{"/sre/*"})
		if err == nil || !strings.Contains(err.Error(), "Cloudflare cache purge request failed") {
			t.Fatalf("Invalidate() error = %v, want transport failure", err)
		}
	})
}

func TestCloudflareInvalidateRejectsMalformedPathsBeforeRequest(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		calls++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"success":true,"result":{"id":"unused"}}`))
	}))
	defer server.Close()

	for _, path := range []string{"", "sre/*", "/sre?x=1", "/sre#fragment"} {
		t.Run(fmt.Sprintf("path_%q", path), func(t *testing.T) {
			if _, err := cloudflareBackendForTest(server).Invalidate(context.Background(), []string{path}); err == nil {
				t.Fatalf("Invalidate(%q) error = nil, want invalid-path error", path)
			}
		})
	}
	if calls != 0 {
		t.Fatalf("purge requests = %d, want no API calls for invalid paths", calls)
	}
}

func TestNewCloudflareBackendValidatesConfigurationAndCredentials(t *testing.T) {
	valid := CloudflareOptions{
		AccountID: "0123456789abcdef0123456789abcdef", Bucket: "pages-prod",
		ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.com",
		AccessKeyID: "r2-access-key", SecretKey: "r2-secret-key", APIToken: "zone-purge-token",
	}

	tests := []struct {
		name   string
		mutate func(*CloudflareOptions)
		want   string
	}{
		{name: "account ID required", mutate: func(options *CloudflareOptions) { options.AccountID = "" }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "account ID format", mutate: func(options *CloudflareOptions) { options.AccountID = "not-an-account-id" }, want: "account and zone IDs must be 32-character hexadecimal IDs"},
		{name: "bucket required", mutate: func(options *CloudflareOptions) { options.Bucket = "" }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "blank bucket rejected", mutate: func(options *CloudflareOptions) { options.Bucket = "  " }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "zone ID required", mutate: func(options *CloudflareOptions) { options.ZoneID = "" }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "zone ID format", mutate: func(options *CloudflareOptions) { options.ZoneID = "not-a-zone-id" }, want: "account and zone IDs must be 32-character hexadecimal IDs"},
		{name: "R2 access key required", mutate: func(options *CloudflareOptions) { options.AccessKeyID = "" }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "blank R2 access key rejected", mutate: func(options *CloudflareOptions) { options.AccessKeyID = "  " }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "R2 secret required", mutate: func(options *CloudflareOptions) { options.SecretKey = "" }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "blank R2 secret rejected", mutate: func(options *CloudflareOptions) { options.SecretKey = "  " }, want: "account, bucket, zone, and R2 credentials are required"},
		{name: "HTTPS origin required", mutate: func(options *CloudflareOptions) { options.PublicBaseURL = "http://pages.example.com" }, want: "HTTPS origin"},
		{name: "origin path rejected", mutate: func(options *CloudflareOptions) { options.PublicBaseURL = "https://pages.example.com/subpath" }, want: "HTTPS origin"},
		{name: "origin credentials rejected", mutate: func(options *CloudflareOptions) { options.PublicBaseURL = "https://user:pass@pages.example.com" }, want: "HTTPS origin"},
		{name: "origin query rejected", mutate: func(options *CloudflareOptions) { options.PublicBaseURL = "https://pages.example.com?preview=1" }, want: "HTTPS origin"},
		{name: "origin fragment rejected", mutate: func(options *CloudflareOptions) { options.PublicBaseURL = "https://pages.example.com#top" }, want: "HTTPS origin"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := valid
			test.mutate(&options)
			_, err := NewCloudflareBackend(context.Background(), options)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("NewCloudflareBackend() error = %v, want %q", err, test.want)
			}
		})
	}

	objectOnly := valid
	objectOnly.APIToken = ""
	backendWithoutPurgeToken, err := NewCloudflareBackend(context.Background(), objectOnly)
	if err != nil {
		t.Fatalf("NewCloudflareBackend(object-only credentials) error = %v", err)
	}
	if _, err := backendWithoutPurgeToken.Invalidate(context.Background(), []string{"/_indexes/sites.json"}); err == nil || !strings.Contains(err.Error(), "API token is required for cache invalidation") {
		t.Fatalf("Invalidate(without zone token) error = %v, want an operation-scoped credential error", err)
	}

	backend, err := NewCloudflareBackend(context.Background(), valid)
	if err != nil {
		t.Fatalf("NewCloudflareBackend(valid) error = %v", err)
	}
	cloudflare, ok := backend.(*cloudflareBackend)
	if !ok {
		t.Fatalf("NewCloudflareBackend() type = %T, want *cloudflareBackend", backend)
	}
	if cloudflare.zoneID != valid.ZoneID || cloudflare.baseURL.String() != valid.PublicBaseURL || cloudflare.apiToken != valid.APIToken {
		t.Errorf("constructed Cloudflare config = zone %q, origin %q, token %q; want configured values", cloudflare.zoneID, cloudflare.baseURL, cloudflare.apiToken)
	}
}

func cloudflareBackendForTest(server *httptest.Server) *cloudflareBackend {
	serverURL, err := url.Parse(server.URL)
	if err != nil {
		panic(err)
	}
	client := server.Client()
	client.Transport = rewriteCloudflareAPITransport{target: serverURL, base: http.DefaultTransport}
	publicBaseURL, _ := url.Parse("https://pages.example.com")
	return &cloudflareBackend{
		zoneID: "0123456789abcdef0123456789abcdef", baseURL: publicBaseURL,
		apiToken: "test-api-token", httpClient: client,
	}
}

type rewriteCloudflareAPITransport struct {
	target *url.URL
	base   http.RoundTripper
}

func (transport rewriteCloudflareAPITransport) RoundTrip(request *http.Request) (*http.Response, error) {
	rewritten := request.Clone(request.Context())
	urlCopy := *request.URL
	urlCopy.Scheme = transport.target.Scheme
	urlCopy.Host = transport.target.Host
	rewritten.URL = &urlCopy
	rewritten.Host = transport.target.Host
	return transport.base.RoundTrip(rewritten)
}
