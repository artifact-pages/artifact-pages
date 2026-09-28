package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	deploymentconfig "github.com/tasuku43/git-artifact-pages/internal/config"
	"github.com/tasuku43/git-artifact-pages/internal/publisher"
)

func TestDeploymentBackendFactoryKeepsGCPProfileLocalOnly(t *testing.T) {
	config := deploymentconfig.DeploymentConfig{
		SchemaVersion: deploymentconfig.SchemaVersion, Provider: "gcp-local", PreviewRetentionDays: 30,
		GCSLocal: &deploymentconfig.GCSLocalTarget{Endpoint: "http://127.0.0.1:4443", Bucket: "artifact-pages"},
	}
	backend, err := newDeploymentBackend(context.Background(), config)
	if err != nil {
		t.Fatalf("newDeploymentBackend(gcp-local): %v", err)
	}
	if _, ok := backend.(publisher.ConditionalObjectBackend); !ok {
		t.Fatalf("backend type %T does not satisfy conditional object contract", backend)
	}
	config.Provider = "gcp"
	config.GCSLocal = nil
	if _, err := newDeploymentBackend(context.Background(), config); err == nil {
		t.Fatal("newDeploymentBackend(gcp) error = nil, want unsupported production provider")
	}
}

func TestCloudflareAppDeployConformance(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_EDGE_PROFILE") != "cloudflare" {
		t.Skip("set ARTIFACT_PAGES_EDGE_PROFILE=cloudflare to run against the local R2-shaped profile")
	}
	for _, name := range []string{"EDGE_R2_ENDPOINT", "EDGE_CF_API_BASE_URL", "CF_R2_ACCESS_KEY_ID", "CF_R2_SECRET_ACCESS_KEY", "CF_API_TOKEN"} {
		if os.Getenv(name) == "" {
			t.Fatalf("local Cloudflare app deployment profile is missing %s", name)
		}
	}

	root := t.TempDir()
	configPath := filepath.Join(root, "deployment.yaml")
	configContents := fmt.Sprintf(`schemaVersion: 1
provider: cloudflare
previewRetentionDays: 30
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  bucket: artifact-pages
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.test
  r2Endpoint: %s
  apiBaseURL: %s
  accessKeyIdEnv: CF_R2_ACCESS_KEY_ID
  secretAccessKeyEnv: CF_R2_SECRET_ACCESS_KEY
  apiTokenEnv: CF_API_TOKEN
`, os.Getenv("EDGE_R2_ENDPOINT"), os.Getenv("EDGE_CF_API_BASE_URL"))
	if err := os.WriteFile(configPath, []byte(configContents), 0o600); err != nil {
		t.Fatal(err)
	}
	deployment, err := deploymentconfig.Parse([]byte(configContents))
	if err != nil {
		t.Fatalf("parse local Cloudflare deployment config: %v", err)
	}
	backend, err := newDeploymentBackend(t.Context(), deployment)
	if err != nil {
		t.Fatalf("create Cloudflare backend: %v", err)
	}
	objects, ok := backend.(publisher.ConditionalObjectBackend)
	if !ok {
		t.Fatalf("Cloudflare backend type %T does not support conditional origin reads", backend)
	}
	contentKeys := []string{
		"_indexes/sites.json",
		"_indexes/sre/index.json",
		"_artifacts/sre/incidents/checkout-latency/index.html",
		"_previews/sre/catalog.json",
	}
	contentBefore := make(map[string][]byte, len(contentKeys))
	for _, key := range contentKeys {
		object, _, err := objects.GetObject(t.Context(), key)
		if err != nil {
			t.Fatalf("snapshot %s before app deployment: %v", key, err)
		}
		contentBefore[key] = append([]byte(nil), object.Bytes...)
	}

	archivePath := createAppBundleForTest(t, filepath.Join(root, "artifact-pages-web-vcloudflare-smoke.tar.gz"), "cloudflare-smoke", map[string][]byte{
		"index.html":        []byte("<!doctype html><script src=\"/assets/app-123.js\"></script>\n"),
		"assets/app-123.js": []byte("console.log('cloudflare app smoke')\n"),
	})
	var stdout, stderr bytes.Buffer
	args := []string{"app", "deploy", "--archive", archivePath, "--config", configPath, "--format", "json"}
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("Cloudflare app deploy error = %v; stderr=%s", err, stderr.String())
	}
	var result publisher.Result
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode Cloudflare app deploy result: %v; output=%s", err, stdout.String())
	}
	if result.Operation != "app deploy" || result.Outcome != "deployed" || result.Version != "cloudflare-smoke" || result.FilesPublished != 2 || result.InvalidationID == "" {
		t.Fatalf("Cloudflare app deploy result = %+v, want two-file publish and cache invalidation", result)
	}

	for key, want := range contentBefore {
		object, _, err := objects.GetObject(t.Context(), key)
		if err != nil || !bytes.Equal(object.Bytes, want) {
			t.Errorf("content object %s changed during app deployment: got=%q want=%q err=%v", key, object.Bytes, want, err)
		}
	}
	index, err := objects.HeadObject(t.Context(), "index.html")
	if err != nil || index.ContentType != "text/html; charset=utf-8" || index.CacheControl != "no-cache, max-age=0, must-revalidate" || index.Metadata["artifact-pages-version"] != result.Version {
		t.Errorf("deployed application shell metadata = %+v, %v", index, err)
	}
	asset, err := objects.HeadObject(t.Context(), "assets/app-123.js")
	if err != nil || asset.ContentType != "text/javascript; charset=utf-8" || asset.CacheControl != "public, max-age=31536000, immutable" || asset.Metadata["artifact-pages-version"] != result.Version {
		t.Errorf("deployed application asset metadata = %+v, %v", asset, err)
	}
}
