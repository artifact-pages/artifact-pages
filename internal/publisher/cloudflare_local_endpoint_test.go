package publisher

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewCloudflareBackendAcceptsPairedLoopbackOverrides(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer endpoint.Close()
	options := CloudflareOptions{
		AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
		ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
		R2Endpoint: endpoint.URL, APIBaseURL: endpoint.URL + "/client/v4",
		AccessKeyID: "r2-access-key", SecretKey: "r2-secret-key", APIToken: "zone-purge-token",
	}
	backend, err := NewCloudflareBackend(context.Background(), options)
	if err != nil {
		t.Fatalf("NewCloudflareBackend(local profile): %v", err)
	}
	cloudflare, ok := backend.(*cloudflareBackend)
	if !ok {
		t.Fatalf("backend type = %T, want *cloudflareBackend", backend)
	}
	if cloudflare.apiBaseURL != endpoint.URL+"/client/v4" {
		t.Fatalf("API base URL = %q, want configured loopback endpoint", cloudflare.apiBaseURL)
	}
}

func TestNewCloudflareBackendRejectsUnpairedOrNonlocalOverrides(t *testing.T) {
	base := CloudflareOptions{
		AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
		ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
		AccessKeyID: "r2-access-key", SecretKey: "r2-secret-key", APIToken: "zone-purge-token",
	}
	cases := []struct {
		name   string
		mutate func(*CloudflareOptions)
		want   string
	}{
		{"only R2 override", func(options *CloudflareOptions) { options.R2Endpoint = "http://127.0.0.1:9000" }, "configured together"},
		{"only API override", func(options *CloudflareOptions) { options.APIBaseURL = "http://127.0.0.1:8787/client/v4" }, "configured together"},
		{"remote R2 endpoint", func(options *CloudflareOptions) {
			options.R2Endpoint, options.APIBaseURL = "https://account.r2.example", "http://127.0.0.1:8787/client/v4"
		}, "HTTP loopback"},
		{"remote API endpoint", func(options *CloudflareOptions) {
			options.R2Endpoint, options.APIBaseURL = "http://127.0.0.1:9000", "http://api.example.test/client/v4"
		}, "HTTP loopback"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			options := base
			test.mutate(&options)
			if _, err := NewCloudflareBackend(context.Background(), options); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("NewCloudflareBackend() error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestCloudflareBackendSignsR2RequestsWithOptionalSessionToken(t *testing.T) {
	const sessionToken = "temporary-r2-session-token"
	var seenToken string
	var seenPath string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		seenToken = request.Header.Get("X-Amz-Security-Token")
		seenPath = request.URL.Path
		writer.Header().Set("ETag", `"cloudflare-etag"`)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	options := CloudflareOptions{
		AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
		ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
		R2Endpoint: server.URL, APIBaseURL: server.URL + "/client/v4",
		AccessKeyID: "temporary-access-key", SecretKey: "temporary-secret-key", SessionToken: sessionToken,
	}
	backend, err := NewCloudflareBackend(context.Background(), options)
	if err != nil {
		t.Fatalf("NewCloudflareBackend(temporary credentials): %v", err)
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		t.Fatalf("backend type = %T, want ConditionalObjectBackend", backend)
	}
	etag, err := conditional.PutObjectConditional(context.Background(), "_control/locks/sites/sre.json", Object{
		Bytes: []byte(`{"site":"sre"}`), ContentType: "application/json",
	}, ObjectCondition{IfNoneMatch: true})
	if err != nil || etag != `"cloudflare-etag"` {
		t.Fatalf("PutObjectConditional() = %q, %v; want S3 response ETag", etag, err)
	}
	if seenToken != sessionToken {
		t.Errorf("X-Amz-Security-Token = %q, want the supplied temporary R2 token", seenToken)
	}
	if seenPath != "/artifact-pages/_control/locks/sites/sre.json" {
		t.Errorf("R2 object path = %q, want path-style bucket/object request", seenPath)
	}
}
