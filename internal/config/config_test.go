package config

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestParseProviderTargets(t *testing.T) {
	tests := []struct {
		name     string
		contents string
		provider string
	}{
		{"local", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n", "local"},
		{"aws", "schemaVersion: 1\nprovider: aws\naws:\n  region: us-east-1\n  bucket: pages-prod\n  distributionId: E123\n", "aws"},
		{"cloudflare", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages-prod\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_R2_ACCESS_KEY_ID\n  secretAccessKeyEnv: CF_R2_SECRET_ACCESS_KEY\n  sessionTokenEnv: CF_R2_SESSION_TOKEN\n  registryReaderAccessKeyIdEnv: CF_R2_REGISTRY_READER_ACCESS_KEY_ID\n  registryReaderSecretAccessKeyEnv: CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY\n  registryReaderSessionTokenEnv: CF_R2_REGISTRY_READER_SESSION_TOKEN\n  apiTokenEnv: CF_API_TOKEN\n", "cloudflare"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			config, err := Parse([]byte(test.contents))
			if err != nil {
				t.Fatalf("Parse() error = %v", err)
			}
			if config.Provider != test.provider {
				t.Errorf("provider = %q, want %q", config.Provider, test.provider)
			}
		})
	}
}

func TestParseProviderDefaultsAndTerraformGeneratedTargets(t *testing.T) {
	cloudflareDefault, err := Parse([]byte(`schemaVersion: 1
provider: cloudflare
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.com
`))
	if err != nil {
		t.Fatalf("Parse(minimal Cloudflare config): %v", err)
	}
	if got := cloudflareDefault.Cloudflare; got.Bucket != "artifact-pages" || got.AccessKeyIDEnv != "CF_R2_ACCESS_KEY_ID" || got.SecretAccessKeyEnv != "CF_R2_SECRET_ACCESS_KEY" || got.APITokenEnv != "CF_API_TOKEN" {
		t.Fatalf("Cloudflare defaults = %+v, want bucket and primary env-name defaults", got)
	}

	cloudflareOverride, err := Parse([]byte(`schemaVersion: 1
provider: cloudflare
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  bucket: custom-r2-bucket
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.com
  accessKeyIdEnv: CUSTOM_ACCESS
  secretAccessKeyEnv: CUSTOM_SECRET
  apiTokenEnv: CUSTOM_API_TOKEN
`))
	if err != nil {
		t.Fatalf("Parse(Cloudflare overrides): %v", err)
	}
	if got := cloudflareOverride.Cloudflare; got.Bucket != "custom-r2-bucket" || got.AccessKeyIDEnv != "CUSTOM_ACCESS" || got.SecretAccessKeyEnv != "CUSTOM_SECRET" || got.APITokenEnv != "CUSTOM_API_TOKEN" {
		t.Fatalf("Cloudflare explicit values = %+v, want configured overrides", got)
	}

	awsDefault, err := Parse([]byte(`schemaVersion: 1
provider: aws
aws:
  accountId: "123456789012"
  region: ap-northeast-1
`))
	if err != nil {
		t.Fatalf("Parse(AWS omitted bucket): %v", err)
	}
	if got := awsDefault.AWS; got.Bucket != "artifact-pages-123456789012-ap-northeast-1" || got.AccountID != "123456789012" {
		t.Fatalf("AWS derived target = %+v, want deterministic account/region bucket", got)
	}

	awsGenerated, err := Parse([]byte(`schemaVersion: 1
provider: aws
aws:
  accountId: "123456789012"
  region: ap-northeast-1
  bucket: artifact-pages-123456789012-ap-northeast-1
  distributionId: E123
`))
	if err != nil {
		t.Fatalf("Parse(Terraform-generated AWS config): %v", err)
	}
	if got := awsGenerated.AWS; got.Bucket != "artifact-pages-123456789012-ap-northeast-1" || got.DistributionID != "E123" {
		t.Fatalf("AWS generated target = %+v, want emitted effective bucket", got)
	}

	cloudflareGenerated, err := Parse([]byte(`schemaVersion: 1
provider: cloudflare
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  bucket: artifact-pages
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.com
`))
	if err != nil || cloudflareGenerated.Cloudflare.Bucket != "artifact-pages" {
		t.Fatalf("Parse(Terraform-generated Cloudflare config) = %+v, %v; want emitted bucket", cloudflareGenerated, err)
	}
}

func TestParseAWSBucketAndAccountIDRules(t *testing.T) {
	tests := []struct {
		name    string
		aws     string
		want    string
		wantErr string
	}{
		{name: "explicit bucket without account ID", aws: "region: us-east-1\nbucket: explicit-bucket", want: "explicit-bucket"},
		{name: "explicit bucket overrides derivation", aws: "accountId: \"123456789012\"\nregion: us-east-1\nbucket: explicit-bucket", want: "explicit-bucket"},
		{name: "missing bucket and account ID", aws: "region: us-east-1", wantErr: "aws.accountId is required when aws.bucket is omitted"},
		{name: "malformed account ID with bucket", aws: "accountId: \"12345678901x\"\nregion: us-east-1\nbucket: explicit-bucket", wantErr: "aws.accountId must be a 12-digit AWS account ID"},
		{name: "malformed account ID without bucket", aws: "accountId: \"12345678901x\"\nregion: us-east-1", wantErr: "aws.accountId must be a 12-digit AWS account ID"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			contents := "schemaVersion: 1\nprovider: aws\naws:\n"
			for _, line := range strings.Split(test.aws, "\n") {
				contents += "  " + line + "\n"
			}
			config, err := Parse([]byte(contents))
			if test.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), test.wantErr) {
					t.Fatalf("Parse() error = %v, want %q", err, test.wantErr)
				}
				return
			}
			if err != nil || config.AWS.Bucket != test.want {
				t.Fatalf("Parse() = %+v, %v; want bucket %q", config.AWS, err, test.want)
			}
		})
	}
}

func TestParseUnifiedConfigSitesAreOptionalForTargetsAndExplicitWhenEmpty(t *testing.T) {
	targetOnly, err := Parse([]byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n"))
	if err != nil || targetOnly.Sites != nil {
		t.Fatalf("target-only config = %+v, err=%v; want valid config with sites omitted", targetOnly, err)
	}

	withSites, err := Parse([]byte(`schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  sre:
    name: SRE & Platform
    description: Incident reviews and operational guidance
    repository: acme/platform
    sourcePath: docs/artifacts
`))
	if err != nil {
		t.Fatalf("Parse(unified config) error = %v", err)
	}
	if got := withSites.Sites["sre"]; got.Name != "SRE & Platform" || got.Description != "Incident reviews and operational guidance" || got.Repository != "acme/platform" {
		t.Fatalf("unified site record = %+v, want name, description, and source mapping from one config", got)
	}

	empty, err := Parse([]byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\nsites: {}\n"))
	if err != nil || empty.Sites == nil || len(empty.Sites) != 0 {
		t.Fatalf("Parse(explicit empty sites) = %+v, err=%v; want non-nil empty map", empty, err)
	}
}

func TestParseRejectsInvalidUnifiedSites(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"sites null", "sites: null\n", "sites must be a mapping"},
		{"sites sequence", "sites: []\n", "sites must be a mapping"},
		{"site sequence", "sites:\n  sre: []\n", `site "sre" must be a mapping`},
		{"description scalar type", "sites:\n  sre:\n    name: SRE\n    description: 42\n    repository: acme/platform\n    sourcePath: docs\n", `site "sre" field "description" must be a string`},
		{"unknown site field", "sites:\n  sre:\n    name: SRE\n    repository: acme/platform\n    sourcePath: docs\n    unknown: unsupported\n", "field unknown not found"},
		{"duplicate site field", "sites:\n  sre:\n    name: First\n    name: Second\n    repository: acme/platform\n    sourcePath: docs\n", "already defined"},
		{"invalid site id", "sites:\n  SRE:\n    name: SRE\n    repository: acme/platform\n    sourcePath: docs\n", "invalid site ID"},
		{"duplicate source mapping", "sites:\n  sre:\n    name: SRE\n    repository: acme/platform\n    sourcePath: docs\n  docs:\n    name: Docs\n    repository: ACME/platform\n    sourcePath: docs\n", "same repository and sourcePath"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n" + test.body
			_, err := Parse([]byte(body))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Parse() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestParseRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"legacy preview retention is unknown", "schemaVersion: 1\nprovider: local\npreviewRetentionDays: 30\nlocal:\n  root: .local\n", "field previewRetentionDays not found"},
		{"unsupported version", "schemaVersion: 2\nprovider: local\nlocal:\n  root: .local\n", "schemaVersion must be 1"},
		{"unknown field", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local\n  bucket: accidental\n", "field bucket not found"},
		{"duplicate key", "schemaVersion: 1\nschemaVersion: 1\nprovider: local\nlocal:\n  root: .local\n", "already defined"},
		{"multiple docs", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local\n---\nschemaVersion: 1\nprovider: local\nlocal:\n  root: .other\n", "exactly one YAML document"},
		{"wrong provider type", "schemaVersion: 1\nprovider: 1\nlocal:\n  root: .local\n", "provider must be a string"},
		{"wrong block type", "schemaVersion: 1\nprovider: local\nlocal: []\n", "local settings must be a mapping"},
		{"wrong setting type", "schemaVersion: 1\nprovider: local\nlocal:\n  root: 42\n", "local.root must be a string"},
		{"missing local block", "schemaVersion: 1\nprovider: local\n", "only the local settings block"},
		{"two provider blocks", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local\naws:\n  bucket: pages\n", "only the local settings block"},
		{"empty aws region", "schemaVersion: 1\nprovider: aws\naws:\n  region: '  '\n  bucket: pages-prod\n", "aws.region is required"},
		{"empty aws bucket", "schemaVersion: 1\nprovider: aws\naws:\n  region: us-east-1\n  bucket: '  '\n", "aws.bucket must not be empty when set"},
		{"empty aws account ID", "schemaVersion: 1\nprovider: aws\naws:\n  region: us-east-1\n  bucket: pages\n  accountId: ''\n", "aws.accountId must not be empty when set"},
		{"cloudflare http base", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: http://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  apiTokenEnv: CF_TOKEN\n", "HTTPS origin"},
		{"cloudflare invalid session token variable", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  sessionTokenEnv: 'CF-SESSION'\n  apiTokenEnv: CF_TOKEN\n", "cloudflare.sessionTokenEnv must name an environment variable"},
		{"empty Cloudflare bucket override", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: ''\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n", "cloudflare.bucket must not be empty when set"},
		{"empty Cloudflare credential-name override", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: ''\n", "cloudflare.accessKeyIdEnv must not be empty when set"},
		{"invalid Cloudflare credential-name override", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF-ACCESS\n", "cloudflare.accessKeyIdEnv must name an environment variable"},
		{"cloudflare incomplete registry reader credentials", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  registryReaderAccessKeyIdEnv: CF_REGISTRY_READ_ACCESS\n  apiTokenEnv: CF_TOKEN\n", "registryReaderAccessKeyIdEnv and registryReaderSecretAccessKeyEnv must be set together"},
		{"cloudflare invalid registry reader session token variable", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  registryReaderAccessKeyIdEnv: CF_REGISTRY_READ_ACCESS\n  registryReaderSecretAccessKeyEnv: CF_REGISTRY_READ_SECRET\n  registryReaderSessionTokenEnv: 'CF-SESSION'\n  apiTokenEnv: CF_TOKEN\n", "cloudflare.registryReaderSessionTokenEnv must name an environment variable"},
		{"cloudflare literal credential field", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  apiTokenEnv: CF_TOKEN\n  apiToken: secret\n", "field apiToken not found"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := Parse([]byte(test.body))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Parse() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestResolvePrecedence(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "user-config")
	if err := os.MkdirAll(filepath.Join(configDir, "artifact-pages"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeConfig(t, filepath.Join(root, "explicit.yaml"), ".explicit")
	writeConfig(t, filepath.Join(root, "env.yaml"), ".env")
	writeConfig(t, filepath.Join(root, defaultConfigName), ".repo")
	writeConfig(t, filepath.Join(root, "saved.yaml"), ".saved")
	savedPath := filepath.Join(configDir, "artifact-pages", savedLocatorName)
	if err := os.WriteFile(savedPath, []byte(filepath.Join(root, "saved.yaml")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	environment := map[string]string{ConfigEnvironment: filepath.Join(root, "env.yaml")}
	resolver := Resolver{
		WorkingDir: root,
		ConfigDir:  configDir,
		Getenv:     func(name string) string { return environment[name] },
	}
	assertRoot := func(label, locator, want string) {
		t.Helper()
		resolved, err := resolver.Resolve(t.Context(), locator)
		if err != nil {
			t.Fatalf("Resolve(%s) error = %v", label, err)
		}
		if resolved.Config.Local.Root != want {
			t.Errorf("Resolve(%s) root = %q, want %q", label, resolved.Config.Local.Root, want)
		}
	}
	assertRoot("explicit", filepath.Join(root, "explicit.yaml"), ".explicit")
	assertRoot("environment", "", ".env")
	delete(environment, ConfigEnvironment)
	assertRoot("repository", "", ".repo")
	if err := os.Remove(filepath.Join(root, defaultConfigName)); err != nil {
		t.Fatal(err)
	}
	assertRoot("saved", "", ".saved")
}

func TestParseRemoteLocatorAcceptsGitHubRepositoryNames(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want remoteLocator
	}{
		{
			name: "leading dot and preserved spelling",
			raw:  "github://AcmeCorp/.github/config.yaml?ref=release%2Fv1",
			want: remoteLocator{Owner: "AcmeCorp", Repo: ".github", File: "config.yaml", Ref: "release/v1"},
		},
		{
			name: "dot in repository name",
			raw:  "github://AcmeCorp/platform.config",
			want: remoteLocator{Owner: "AcmeCorp", Repo: "platform.config"},
		},
		{
			name: "digit-leading repository name",
			raw:  "github://AcmeCorp/123project",
			want: remoteLocator{Owner: "AcmeCorp", Repo: "123project"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := parseRemoteLocator(test.raw)
			if err != nil {
				t.Fatalf("parseRemoteLocator() error = %v", err)
			}
			if got != test.want {
				t.Errorf("parseRemoteLocator() = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestResolveRemoteConfigRejectsUnsafeLocatorsBeforeRequest(t *testing.T) {
	tooLongRepository := strings.Repeat("a", 101)
	locators := []string{
		"github://acme",
		"github://acme//repo",
		"github://acme/repo/",
		"github://acme/repo//config.yaml",
		"github://acme/%2e%2e",
		"github://acme/repo/%2e%2e/config.yaml",
		"github://acme/repo/config%2Funsafe.yaml",
		"github://acme/repo/config%5Cunsafe.yaml",
		"github://acme/repo!",
		"github://acme/.",
		"github://acme/..",
		"github://acme/repo.git",
		"github://acme/" + tooLongRepository,
		"github://acme/repo?ref=",
		"github://acme/repo?ref=one&ref=two",
		"github://acme/repo?ref=%ZZ",
		"github://acme/repo?branch=main",
		"github://acme/repo#fragment",
	}
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		requests++
		writer.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()
	resolver := Resolver{GitHubAPIBaseURL: server.URL}
	for _, locator := range locators {
		t.Run(locator, func(t *testing.T) {
			if _, err := resolver.Resolve(t.Context(), locator); err == nil {
				t.Fatalf("Resolve(%q) succeeded, want locator validation error", locator)
			}
		})
	}
	if requests != 0 {
		t.Errorf("GitHub API requests = %d, want no requests for invalid locators", requests)
	}
}

func TestResolveRemoteConfigSupportsValidRepositoryNamesAndExplicitPrecedence(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	configBytes := []byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n")
	for _, repository := range []string{".github", "platform.config", "123project"} {
		t.Run(repository, func(t *testing.T) {
			var requests []string
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				requests = append(requests, request.URL.EscapedPath()+"?"+request.URL.RawQuery)
				wantPath := "/repos/AcmeCorp/" + repository + "/contents/.artifact-pages.yaml"
				if request.URL.Path != wantPath {
					t.Errorf("GitHub API path = %q, want %q", request.URL.Path, wantPath)
				}
				if request.URL.Query().Get("ref") != sha {
					t.Errorf("GitHub API ref = %q, want %q", request.URL.Query().Get("ref"), sha)
				}
				_ = json.NewEncoder(writer).Encode(githubContent{
					Type: "file", Encoding: "base64", Content: base64.StdEncoding.EncodeToString(configBytes), SHA: "file-sha",
				})
			}))
			defer server.Close()

			resolver := Resolver{
				GitHubAPIBaseURL: server.URL,
				Getenv: func(name string) string {
					if name == ConfigEnvironment {
						return "github://IgnoredOrg/ignored?ref=" + sha
					}
					return ""
				},
			}
			locator := "github://AcmeCorp/" + repository + "/.artifact-pages.yaml?ref=" + sha
			resolved, err := resolver.Resolve(t.Context(), locator)
			if err != nil {
				t.Fatalf("Resolve(%q) error = %v", locator, err)
			}
			wantLocator := "github://AcmeCorp/" + repository + "/.artifact-pages.yaml?ref=" + sha
			if resolved.Locator != wantLocator || resolved.CommitSHA != sha || resolved.Config.Provider != "local" {
				t.Fatalf("Resolve() = %+v, want explicit repository locator and pinned config", resolved)
			}
			if len(requests) != 1 {
				t.Fatalf("GitHub API requests = %v, want one request using the explicit locator", requests)
			}
		})
	}
}

func TestSetDefaultStoresOnlyAbsoluteLocatorWithPrivateMode(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "user-config")
	resolver := Resolver{WorkingDir: root, ConfigDir: configDir}
	path, err := resolver.SetDefault("target.yaml")
	if err != nil {
		t.Fatalf("SetDefault() error = %v", err)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != filepath.Join(root, "target.yaml")+"\n" {
		t.Errorf("saved locator = %q, want absolute path", contents)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("saved locator permissions = %o, want 600", info.Mode().Perm())
	}
}

func TestResolveRemoteConfigPinsOneUnifiedConfigCommitWithoutLegacyFallback(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	configBytes := []byte("schemaVersion: 1\nprovider: aws\naws:\n  region: us-west-2\n  bucket: pages-prod\n  distributionId: E123\nsites:\n  sre:\n    name: SRE\n    description: Operations\n    repository: acme/platform\n    sourcePath: docs/artifacts\n")
	satellite := t.TempDir()
	localConfigPath := filepath.Join(satellite, "deployment.yaml")
	if err := os.WriteFile(localConfigPath, configBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	localResolved, err := (Resolver{WorkingDir: satellite}).Resolve(t.Context(), localConfigPath)
	if err != nil {
		t.Fatalf("Resolve(local config) error = %v", err)
	}
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests = append(requests, request.URL.Path+"?"+request.URL.RawQuery)
		if request.Header.Get("Authorization") != "Bearer test-token" {
			t.Errorf("authorization header = %q, want configured token", request.Header.Get("Authorization"))
		}
		switch {
		case request.URL.Path == "/repos/acme/admin":
			_, _ = writer.Write([]byte(`{"default_branch":"main"}`))
		case request.URL.Path == "/repos/acme/admin/commits/main":
			_, _ = fmt.Fprintf(writer, `{"sha":%q}`, sha)
		case request.URL.Path == "/repos/acme/admin/contents/.artifact-pages.yaml":
			writer.WriteHeader(http.StatusNotFound)
		case request.URL.Path == "/repos/acme/admin/contents/artifact-pages.yaml":
			_ = json.NewEncoder(writer).Encode(githubContent{
				Type: "file", Encoding: "base64", Content: base64.StdEncoding.EncodeToString(configBytes), SHA: "file-sha",
			})
		case request.URL.Path == "/repos/acme/admin/contents/artifact-pages.cloudflare.yaml":
			_ = json.NewEncoder(writer).Encode(githubContent{
				Type: "file", Encoding: "base64", Content: base64.StdEncoding.EncodeToString(configBytes), SHA: "file-sha",
			})
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	resolver := Resolver{
		WorkingDir:       satellite,
		GitHubAPIBaseURL: server.URL,
		Getenv: func(name string) string {
			if name == "GITHUB_TOKEN" {
				return "test-token"
			}
			return ""
		},
	}
	_, err = resolver.Resolve(t.Context(), "github://acme/admin")
	if err == nil || !strings.Contains(err.Error(), "GitHub config fetch failed for .artifact-pages.yaml (HTTP 404)") {
		t.Fatalf("Resolve(remote default) error = %v, want the default file's 404 without legacy fallback", err)
	}
	if len(requests) != 3 || requests[2] != "/repos/acme/admin/contents/.artifact-pages.yaml?ref="+sha {
		t.Fatalf("GitHub requests = %v, want metadata, commit, and one pinned default-file request", requests)
	}

	requests = nil
	remote, err := resolver.Resolve(t.Context(), "github://acme/admin/artifact-pages.cloudflare.yaml?ref="+sha)
	if err != nil {
		t.Fatalf("Resolve(arbitrary remote config) error = %v", err)
	}
	if remote.CommitSHA != sha || remote.Config.Provider != "aws" || remote.Config.Sites["sre"].Description != "Operations" || !strings.Contains(remote.Locator, "artifact-pages.cloudflare.yaml") {
		t.Fatalf("resolved config = %+v, want one pinned config with provider and sites", remote)
	}
	if !reflect.DeepEqual(remote.Config, localResolved.Config) {
		t.Fatalf("local and remote config differ:\nlocal:  %+v\nremote: %+v", localResolved.Config, remote.Config)
	}
	if len(requests) != 1 || !strings.Contains(requests[0], "ref="+sha) {
		t.Fatalf("arbitrary config fetches = %v, want a single file read at pinned commit", requests)
	}
}

func TestResolveRemoteConfigDoesNotFallbackOnAuthorizationFailure(t *testing.T) {
	var requested []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requested = append(requested, request.URL.Path)
		if request.URL.Path == "/repos/acme/admin" {
			_, _ = writer.Write([]byte(`{"default_branch":"main"}`))
			return
		}
		if request.URL.Path == "/repos/acme/admin/commits/main" {
			_, _ = writer.Write([]byte(`{"sha":"0123456789abcdef0123456789abcdef01234567"}`))
			return
		}
		writer.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()
	resolver := Resolver{GitHubAPIBaseURL: server.URL}
	_, err := resolver.Resolve(t.Context(), "github://acme/admin")
	if err == nil || !strings.Contains(err.Error(), "HTTP 403") || strings.Contains(err.Error(), "Bearer") {
		t.Fatalf("Resolve(remote) error = %v, want redacted HTTP 403", err)
	}
	if len(requested) != 3 {
		t.Fatalf("requests after forbidden default file = %v; fallback must not occur", requested)
	}
}

func writeConfig(t *testing.T, filePath, root string) {
	t.Helper()
	contents := fmt.Sprintf("schemaVersion: 1\nprovider: local\nlocal:\n  root: %s\n", root)
	if err := os.WriteFile(filePath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}
