package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

func TestNewDeploymentBackendWiresCloudflareRegistryReaderEnvironment(t *testing.T) {
	for name, value := range map[string]string{
		"CF_ACCESS":               "site-writer",
		"CF_SECRET":               "site-writer-secret",
		"CF_TOKEN":                "zone-purge-token",
		"CF_REGISTRY_READ_ACCESS": "registry-reader",
		"CF_REGISTRY_READ_SECRET": "registry-reader-secret",
	} {
		t.Setenv(name, value)
	}
	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Content-Length", "12")
		writer.Header().Set("ETag", `"registry-etag"`)
		_, _ = io.WriteString(writer, `{"sites":[]}`)
	}))
	defer server.Close()

	backendValue, err := newDeploymentBackendWithCapabilities(context.Background(), deploymentconfig.DeploymentConfig{
		SchemaVersion: 1,
		Provider:      "cloudflare",
		Cloudflare: &deploymentconfig.CloudflareTarget{
			AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
			ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
			R2Endpoint: server.URL, APIBaseURL: server.URL + "/client/v4",
			AccessKeyIDEnv: "CF_ACCESS", SecretAccessKeyEnv: "CF_SECRET", APITokenEnv: "CF_TOKEN",
			RegistryReaderAccessKeyIDEnv: "CF_REGISTRY_READ_ACCESS", RegistryReaderSecretAccessKeyEnv: "CF_REGISTRY_READ_SECRET",
		},
	}, deploymentBackendCapabilities{useRegistryReader: true})
	if err != nil {
		t.Fatalf("newDeploymentBackend(): %v", err)
	}
	backend, ok := backendValue.(publisher.ConditionalObjectBackend)
	if !ok {
		t.Fatalf("newDeploymentBackend() type = %T, want ConditionalObjectBackend", backendValue)
	}
	if _, _, err := backend.GetObject(context.Background(), "_indexes/sites.json"); err != nil {
		t.Fatalf("GetObject(registry): %v", err)
	}
	if !strings.Contains(authorization, "Credential=registry-reader/") {
		t.Fatalf("registry Authorization = %q, want registry-reader credential", authorization)
	}
}

func TestNewDeploymentBackendDoesNotRequireUnusedCloudflareRegistryReader(t *testing.T) {
	for name, value := range map[string]string{
		"CF_ACCESS":               "site-writer",
		"CF_SECRET":               "site-writer-secret",
		"CF_TOKEN":                "zone-purge-token",
		"CF_REGISTRY_READ_ACCESS": "",
		"CF_REGISTRY_READ_SECRET": "",
	} {
		t.Setenv(name, value)
	}
	config := deploymentconfig.DeploymentConfig{
		SchemaVersion: 1,
		Provider:      "cloudflare",
		Cloudflare: &deploymentconfig.CloudflareTarget{
			AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
			ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
			AccessKeyIDEnv: "CF_ACCESS", SecretAccessKeyEnv: "CF_SECRET", APITokenEnv: "CF_TOKEN",
			RegistryReaderAccessKeyIDEnv: "CF_REGISTRY_READ_ACCESS", RegistryReaderSecretAccessKeyEnv: "CF_REGISTRY_READ_SECRET",
		},
	}
	backend, err := newDeploymentBackend(context.Background(), config)
	if err != nil {
		t.Fatalf("newDeploymentBackend() with unused reader config: %v", err)
	}
	if backend == nil {
		t.Fatal("newDeploymentBackend() returned a nil backend")
	}
	if _, err := newDeploymentBackendWithCapabilities(context.Background(), config, deploymentBackendCapabilities{useRegistryReader: true}); err == nil || !strings.Contains(err.Error(), "registry reader credentials named by deployment config are not set") {
		t.Fatalf("registry-reading backend error = %v, want missing configured reader credentials", err)
	}
}

func TestNewDeploymentBackendDerivesCloudflareR2CredentialsFromNamedAPIToken(t *testing.T) {
	const apiToken = "config-token-for-derived-r2"
	const tokenID = "fedcba9876543210fedcba9876543210"
	const accountID = "0123456789abcdef0123456789abcdef"
	var verifyRequests, objectRequests int
	var verificationAuthorization, objectAuthorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/client/v4/accounts/"+accountID+"/tokens/verify":
			verifyRequests++
			verificationAuthorization = request.Header.Get("Authorization")
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, `{"success":true,"result":{"id":"`+tokenID+`","status":"active"}}`)
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

	t.Setenv("CF_R2_ACCESS_KEY_ID", "")
	t.Setenv("CF_R2_SECRET_ACCESS_KEY", "")
	t.Setenv("CF_TOKEN_ONLY", apiToken)
	config := deploymentconfig.DeploymentConfig{
		SchemaVersion: 1,
		Provider:      "cloudflare",
		Cloudflare: &deploymentconfig.CloudflareTarget{
			AccountID: accountID, Bucket: "artifact-pages", ZoneID: "abcdef0123456789abcdef0123456789",
			PublicBaseURL: "https://pages.example.test", R2Endpoint: server.URL, APIBaseURL: server.URL + "/client/v4",
			APITokenEnv: "CF_TOKEN_ONLY",
		},
	}
	backend, err := newDeploymentBackend(context.Background(), config)
	if err != nil {
		t.Fatal("newDeploymentBackend() rejected a Cloudflare config with only a named API token")
	}
	if verifyRequests != 1 || verificationAuthorization != "Bearer "+apiToken {
		t.Fatal("newDeploymentBackend() did not verify the token named by apiTokenEnv")
	}
	if err := backend.PutObject(context.Background(), "_artifacts/guide/index.html", publisher.Object{
		Bytes: []byte("page"), ContentType: "text/html; charset=utf-8",
	}); err != nil {
		t.Fatal("newDeploymentBackend() did not use the derived R2 credentials")
	}
	if objectRequests != 1 || !strings.Contains(objectAuthorization, "Credential="+tokenID+"/") {
		t.Fatal("newDeploymentBackend() did not sign the R2 request with the verified token ID")
	}
}
