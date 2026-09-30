package config

import (
	"strings"
	"testing"
)

func TestParseLocalObjectStorageProfiles(t *testing.T) {
	validGCS := `schemaVersion: 1
provider: gcp-local
gcpLocal:
  endpoint: http://127.0.0.1:4443
  bucket: artifact-pages
`
	parsed, err := Parse([]byte(validGCS))
	if err != nil {
		t.Fatalf("Parse(gcp-local): %v", err)
	}
	if parsed.Provider != "gcp-local" || parsed.GCSLocal == nil || parsed.GCSLocal.Bucket != "artifact-pages" {
		t.Fatalf("parsed GCP local target = %+v", parsed)
	}

	validCloudflare := `schemaVersion: 1
provider: cloudflare
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  bucket: artifact-pages
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.test
  r2Endpoint: http://localhost:9000
  apiBaseURL: http://127.0.0.1:8787/client/v4
  accessKeyIdEnv: R2_ACCESS_KEY_ID
  secretAccessKeyEnv: R2_SECRET_ACCESS_KEY
  apiTokenEnv: CF_API_TOKEN
`
	if _, err := Parse([]byte(validCloudflare)); err != nil {
		t.Fatalf("Parse(cloudflare local endpoints): %v", err)
	}

	for name, body := range map[string]string{
		"external GCP endpoint":         strings.Replace(validGCS, "http://127.0.0.1:4443", "http://storage.example.test", 1),
		"production GCP is unsupported": strings.Replace(validGCS, "provider: gcp-local", "provider: gcp", 1),
		"gcp local mixed with aws":      strings.Replace(validGCS, "  bucket: artifact-pages", "  bucket: artifact-pages\naws:\n  region: us-east-1\n  bucket: elsewhere", 1),
		"cloudflare remote override":    strings.Replace(validCloudflare, "http://localhost:9000", "https://account.r2.cloudflarestorage.com", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Parse([]byte(body)); err == nil {
				t.Fatal("Parse() error = nil, want local profile validation error")
			}
		})
	}
}
