package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

const (
	cloudflareTestAccountID = "0123456789abcdef0123456789abcdef"
	cloudflareTestZoneID    = "abcdef0123456789abcdef0123456789"
	cloudflareTestTokenID   = "fedcba9876543210fedcba9876543210"
	cloudflareTestAPIToken  = "test-account-api-token-value"
)

func TestNewCloudflareBackendDerivesAndSignsWithAccountTokenCredentials(t *testing.T) {
	var verifyRequests, objectRequests, tokenReads int
	var verificationAuthorization, objectAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path == cloudflareTokenVerifyPath(cloudflareTestAccountID):
			verifyRequests++
			verificationAuthorization = request.Header.Get("Authorization")
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(cloudflareActiveTokenResponse(cloudflareTestTokenID)))
		case request.Method == http.MethodPut && request.URL.Path == "/artifact-pages/_artifacts/guide/index.html":
			objectRequests++
			objectAuthorization = request.Header.Get("Authorization")
			writer.Header().Set("ETag", `"object-etag"`)
			writer.WriteHeader(http.StatusOK)
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	options := cloudflareTokenTestOptions(server.URL)
	options.APITokenProvider = func() string {
		tokenReads++
		return cloudflareTestAPIToken
	}
	backendValue, err := NewCloudflareBackend(context.Background(), options)
	if err != nil {
		t.Fatal("NewCloudflareBackend() rejected a verified account token")
	}
	if tokenReads != 1 || verifyRequests != 1 || verificationAuthorization != "Bearer "+cloudflareTestAPIToken {
		t.Fatal("token derivation did not read the configured token once and verify it with bearer authorization")
	}
	cloudflare, ok := backendValue.(*cloudflareBackend)
	if !ok {
		t.Fatal("NewCloudflareBackend() returned an unexpected backend type")
	}
	assertCloudflareDerivedCredentials(t, cloudflare, cloudflareTestAPIToken, cloudflareTestTokenID)
	if err := backendValue.PutObject(context.Background(), "_artifacts/guide/index.html", Object{
		Bytes: []byte("page"), ContentType: "text/html; charset=utf-8",
	}); err != nil {
		t.Fatal("PutObject() failed with the derived credentials")
	}
	if objectRequests != 1 || !strings.Contains(objectAuthorization, "Credential="+cloudflareTestTokenID+"/") {
		t.Fatal("R2 signing did not use the access key ID returned by token verification")
	}
	if tokenReads != 1 || verifyRequests != 1 {
		t.Fatal("R2 signing unexpectedly reread or reverified the API token")
	}
}

func TestNewCloudflareBackendUsesAPITokenWhenProviderIsAbsent(t *testing.T) {
	var verifyRequests int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		verifyRequests++
		if request.Method != http.MethodGet || request.URL.Path != cloudflareTokenVerifyPath(cloudflareTestAccountID) || request.Header.Get("Authorization") != "Bearer "+cloudflareTestAPIToken {
			http.Error(writer, "unexpected request", http.StatusBadRequest)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(cloudflareActiveTokenResponse(cloudflareTestTokenID)))
	}))
	defer server.Close()

	options := cloudflareTokenTestOptions(server.URL)
	options.APIToken = cloudflareTestAPIToken
	backendValue, err := NewCloudflareBackend(context.Background(), options)
	if err != nil {
		t.Fatal("NewCloudflareBackend() did not use the configured API token fallback")
	}
	if verifyRequests != 1 {
		t.Fatal("NewCloudflareBackend() did not verify the API token exactly once")
	}
	cloudflare, ok := backendValue.(*cloudflareBackend)
	if !ok {
		t.Fatal("NewCloudflareBackend() returned an unexpected backend type")
	}
	assertCloudflareDerivedCredentials(t, cloudflare, cloudflareTestAPIToken, cloudflareTestTokenID)
}

func TestNewCloudflareBackendKeepsExplicitR2CredentialsAndPurgeTokenLazy(t *testing.T) {
	var verifyRequests, purgeRequests, tokenReads int
	var purgeAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case cloudflareTokenVerifyPath(cloudflareTestAccountID):
			verifyRequests++
			http.Error(writer, "verification must not be requested", http.StatusInternalServerError)
		case "/client/v4/zones/" + cloudflareTestZoneID + "/purge_cache":
			purgeRequests++
			purgeAuthorization = request.Header.Get("Authorization")
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"success":true,"result":{"id":"purge-id"}}`))
		default:
			http.NotFound(writer, request)
		}
	}))
	defer server.Close()

	options := cloudflareTokenTestOptions(server.URL)
	options.AccessKeyID = "explicit-r2-access-key"
	options.SecretKey = "explicit-r2-secret-key"
	options.APITokenProvider = func() string {
		tokenReads++
		return cloudflareTestAPIToken
	}
	backendValue, err := NewCloudflareBackend(context.Background(), options)
	if err != nil {
		t.Fatal("NewCloudflareBackend() rejected an explicit R2 key pair")
	}
	if tokenReads != 0 || verifyRequests != 0 {
		t.Fatal("explicit R2 credentials caused eager API token reads or verification")
	}
	if _, err := backendValue.Invalidate(context.Background(), []string{"/index.html"}); err != nil {
		t.Fatal("Invalidate() failed with the lazy purge token")
	}
	if verifyRequests != 0 || purgeRequests != 1 || tokenReads == 0 || purgeAuthorization != "Bearer "+cloudflareTestAPIToken {
		t.Fatal("explicit R2 credentials did not preserve the existing lazy purge-token path")
	}
}

func TestNewCloudflareBackendRejectsPartialOrSessionOnlyR2CredentialsBeforeVerification(t *testing.T) {
	var requests, tokenReads int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(cloudflareActiveTokenResponse(cloudflareTestTokenID)))
	}))
	defer server.Close()

	tests := []struct {
		name   string
		mutate func(*CloudflareOptions)
		want   string
	}{
		{name: "access key without secret", mutate: func(options *CloudflareOptions) { options.AccessKeyID = "partial-key" }, want: "set together"},
		{name: "secret without access key", mutate: func(options *CloudflareOptions) { options.SecretKey = "partial-secret" }, want: "set together"},
		{name: "session token without pair", mutate: func(options *CloudflareOptions) { options.SessionToken = "temporary-session" }, want: "requires an explicit access key ID and secret"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := cloudflareTokenTestOptions(server.URL)
			options.APITokenProvider = func() string {
				tokenReads++
				return cloudflareTestAPIToken
			}
			test.mutate(&options)
			if _, err := NewCloudflareBackend(context.Background(), options); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatal("NewCloudflareBackend() did not reject the incomplete R2 credentials")
			} else if strings.Contains(err.Error(), cloudflareTestAPIToken) {
				t.Fatal("credential validation error exposed the API token")
			}
		})
	}
	if requests != 0 || tokenReads != 0 {
		t.Fatal("incomplete R2 credentials triggered token reads or HTTP requests")
	}
}

func TestNewCloudflareBackendValidatesStaticConfigurationBeforeTokenVerification(t *testing.T) {
	var requests, tokenReads int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(cloudflareActiveTokenResponse(cloudflareTestTokenID)))
	}))
	defer server.Close()

	tests := []struct {
		name   string
		mutate func(*CloudflareOptions)
	}{
		{name: "invalid account ID", mutate: func(options *CloudflareOptions) { options.AccountID = "not-an-account-id" }},
		{name: "invalid zone ID", mutate: func(options *CloudflareOptions) { options.ZoneID = "not-a-zone-id" }},
		{name: "invalid public origin", mutate: func(options *CloudflareOptions) { options.PublicBaseURL = "http://pages.example.test" }},
		{name: "unpaired local endpoint override", mutate: func(options *CloudflareOptions) { options.APIBaseURL = "" }},
		{name: "nonlocal endpoint overrides", mutate: func(options *CloudflareOptions) {
			options.R2Endpoint = "https://r2.example.test"
			options.APIBaseURL = "https://api.example.test/client/v4"
		}},
		{name: "incomplete registry reader pair", mutate: func(options *CloudflareOptions) { options.RegistryReaderAccessKeyID = "reader-key" }},
		{name: "registry reader session token without pair", mutate: func(options *CloudflareOptions) { options.RegistryReaderSessionToken = "reader-session" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			options := cloudflareTokenTestOptions(server.URL)
			options.APITokenProvider = func() string {
				tokenReads++
				return cloudflareTestAPIToken
			}
			test.mutate(&options)
			if _, err := NewCloudflareBackend(context.Background(), options); err == nil {
				t.Fatal("NewCloudflareBackend() accepted invalid static configuration")
			}
		})
	}
	if requests != 0 || tokenReads != 0 {
		t.Fatal("invalid static configuration triggered token reads or HTTP requests")
	}
}

func TestNewCloudflareBackendRejectsInvalidTokenVerificationResponsesWithoutEchoingBody(t *testing.T) {
	const responseEcho = "provider response must stay private"
	tests := []struct {
		name       string
		statusCode int
		body       string
		location   string
		wantError  string
	}{
		{name: "HTTP failure", statusCode: http.StatusUnauthorized, body: `{"success":false,"errors":[{"message":"` + cloudflareTestAPIToken + `"}]}`, wantError: "HTTP 401"},
		{name: "unsuccessful envelope", statusCode: http.StatusOK, body: `{"success":false,"errors":[{"message":"` + responseEcho + `"}]}`, wantError: "active token ID"},
		{name: "inactive token", statusCode: http.StatusOK, body: `{"success":true,"result":{"id":"` + cloudflareTestTokenID + `","status":"inactive"}}`, wantError: "active token ID"},
		{name: "malformed response", statusCode: http.StatusOK, body: responseEcho, wantError: "invalid response"},
		{name: "malformed token ID", statusCode: http.StatusOK, body: `{"success":true,"result":{"id":"not-an-id","status":"active"}}`, wantError: "active token ID"},
		{name: "oversized response", statusCode: http.StatusOK, body: strings.Repeat("x", cloudflareTokenVerificationResponseLimit+1), wantError: "too large"},
		{name: "redirect", statusCode: http.StatusFound, body: responseEcho, location: "/client/v4/redirect-target", wantError: "HTTP 302"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var requests, redirectRequests int
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				requests++
				if request.URL.Path == "/client/v4/redirect-target" {
					redirectRequests++
					writer.Header().Set("Content-Type", "application/json")
					_, _ = writer.Write([]byte(cloudflareActiveTokenResponse(cloudflareTestTokenID)))
					return
				}
				if test.location != "" {
					writer.Header().Set("Location", test.location)
				}
				writer.WriteHeader(test.statusCode)
				_, _ = writer.Write([]byte(test.body))
			}))
			defer server.Close()

			options := cloudflareTokenTestOptions(server.URL)
			options.APITokenProvider = func() string { return cloudflareTestAPIToken }
			if _, err := NewCloudflareBackend(context.Background(), options); err == nil {
				t.Fatal("NewCloudflareBackend() accepted an invalid token-verification response")
			} else {
				if !strings.Contains(err.Error(), test.wantError) {
					t.Fatal("token-verification error omitted its safe context")
				}
				if strings.Contains(err.Error(), cloudflareTestAPIToken) || strings.Contains(err.Error(), responseEcho) {
					t.Fatal("token-verification error exposed the API token or provider response body")
				}
			}
			if requests != 1 || redirectRequests != 0 {
				t.Fatal("token verification followed a redirect or issued an unexpected request")
			}
		})
	}
}

func TestNewCloudflareBackendTokenVerificationHonorsContextCancellation(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(cloudflareActiveTokenResponse(cloudflareTestTokenID)))
	}))
	defer server.Close()

	options := cloudflareTokenTestOptions(server.URL)
	options.APITokenProvider = func() string { return cloudflareTestAPIToken }
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := NewCloudflareBackend(ctx, options); err == nil || !strings.Contains(err.Error(), "canceled") {
		t.Fatal("NewCloudflareBackend() ignored context cancellation")
	} else if strings.Contains(err.Error(), cloudflareTestAPIToken) {
		t.Fatal("context cancellation error exposed the API token")
	}
	if requests != 0 {
		t.Fatal("a canceled token verification reached the server")
	}
}

func cloudflareTokenTestOptions(endpoint string) CloudflareOptions {
	return CloudflareOptions{
		AccountID: cloudflareTestAccountID, Bucket: "artifact-pages", ZoneID: cloudflareTestZoneID,
		PublicBaseURL: "https://pages.example.test", R2Endpoint: endpoint, APIBaseURL: endpoint + "/client/v4",
	}
}

func cloudflareTokenVerifyPath(accountID string) string {
	return "/client/v4/accounts/" + accountID + "/tokens/verify"
}

func cloudflareActiveTokenResponse(tokenID string) string {
	return fmt.Sprintf(`{"success":true,"result":{"id":"%s","status":"active"}}`, tokenID)
}

func assertCloudflareDerivedCredentials(t *testing.T, backend *cloudflareBackend, apiToken, tokenID string) {
	t.Helper()
	client, ok := backend.objects.client.(*s3.Client)
	if !ok {
		t.Fatal("Cloudflare R2 object client has an unexpected type")
	}
	credentials, err := client.Options().Credentials.Retrieve(context.Background())
	if err != nil {
		t.Fatal("could not retrieve the derived R2 credentials")
	}
	secret := sha256.Sum256([]byte(apiToken))
	if credentials.AccessKeyID != tokenID || credentials.SecretAccessKey != hex.EncodeToString(secret[:]) {
		t.Fatal("Cloudflare R2 credentials do not match the verified token ID and its SHA-256")
	}
}
