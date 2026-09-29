package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	deploymentconfig "github.com/tasuku43/git-artifact-pages/internal/config"
	"github.com/tasuku43/git-artifact-pages/internal/publisher"
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

	backendValue, err := newDeploymentBackend(context.Background(), deploymentconfig.DeploymentConfig{
		SchemaVersion: 1,
		Provider:      "cloudflare",
		Cloudflare: &deploymentconfig.CloudflareTarget{
			AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
			ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
			R2Endpoint: server.URL, APIBaseURL: server.URL + "/client/v4",
			AccessKeyIDEnv: "CF_ACCESS", SecretAccessKeyEnv: "CF_SECRET", APITokenEnv: "CF_TOKEN",
			RegistryReaderAccessKeyIDEnv: "CF_REGISTRY_READ_ACCESS", RegistryReaderSecretAccessKeyEnv: "CF_REGISTRY_READ_SECRET",
		},
	})
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

func TestNewDeploymentBackendRejectsMissingConfiguredCloudflareRegistryReader(t *testing.T) {
	for name, value := range map[string]string{
		"CF_ACCESS":               "site-writer",
		"CF_SECRET":               "site-writer-secret",
		"CF_TOKEN":                "zone-purge-token",
		"CF_REGISTRY_READ_ACCESS": "",
		"CF_REGISTRY_READ_SECRET": "",
	} {
		t.Setenv(name, value)
	}
	_, err := newDeploymentBackend(context.Background(), deploymentconfig.DeploymentConfig{
		SchemaVersion: 1,
		Provider:      "cloudflare",
		Cloudflare: &deploymentconfig.CloudflareTarget{
			AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
			ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
			AccessKeyIDEnv: "CF_ACCESS", SecretAccessKeyEnv: "CF_SECRET", APITokenEnv: "CF_TOKEN",
			RegistryReaderAccessKeyIDEnv: "CF_REGISTRY_READ_ACCESS", RegistryReaderSecretAccessKeyEnv: "CF_REGISTRY_READ_SECRET",
		},
	})
	if err == nil || !strings.Contains(err.Error(), "registry reader credentials named by deployment config are not set") {
		t.Fatalf("newDeploymentBackend() error = %v, want missing configured reader credentials", err)
	}
}
