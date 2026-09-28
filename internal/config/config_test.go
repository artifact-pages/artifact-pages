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
		{"aws", "schemaVersion: 1\nprovider: aws\npreviewRetentionDays: 30\naws:\n  region: us-east-1\n  bucket: pages-prod\n  distributionId: E123\n", "aws"},
		{"cloudflare", "schemaVersion: 1\nprovider: cloudflare\npreviewRetentionDays: 30\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages-prod\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_R2_ACCESS_KEY_ID\n  secretAccessKeyEnv: CF_R2_SECRET_ACCESS_KEY\n  sessionTokenEnv: CF_R2_SESSION_TOKEN\n  registryReaderAccessKeyIdEnv: CF_R2_REGISTRY_READER_ACCESS_KEY_ID\n  registryReaderSecretAccessKeyEnv: CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY\n  registryReaderSessionTokenEnv: CF_R2_REGISTRY_READER_SESSION_TOKEN\n  apiTokenEnv: CF_API_TOKEN\n", "cloudflare"},
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

func TestParseRejectsInvalidConfig(t *testing.T) {
	tests := []struct {
		name string
		body string
		want string
	}{
		{"unsupported version", "schemaVersion: 2\nprovider: local\nlocal:\n  root: .local\n", "schemaVersion must be 1"},
		{"unknown field", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local\n  bucket: accidental\n", "field bucket not found"},
		{"duplicate key", "schemaVersion: 1\nschemaVersion: 1\nprovider: local\nlocal:\n  root: .local\n", "already defined"},
		{"multiple docs", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local\n---\nschemaVersion: 1\nprovider: local\nlocal:\n  root: .other\n", "exactly one YAML document"},
		{"wrong provider type", "schemaVersion: 1\nprovider: 1\nlocal:\n  root: .local\n", "provider must be a string"},
		{"wrong block type", "schemaVersion: 1\nprovider: local\nlocal: []\n", "local settings must be a mapping"},
		{"wrong setting type", "schemaVersion: 1\nprovider: local\nlocal:\n  root: 42\n", "local.root must be a string"},
		{"missing local block", "schemaVersion: 1\nprovider: local\n", "only the local settings block"},
		{"two provider blocks", "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local\naws:\n  bucket: pages\n", "only the local settings block"},
		{"empty aws region", "schemaVersion: 1\nprovider: aws\npreviewRetentionDays: 30\naws:\n  region: '  '\n  bucket: pages-prod\n", "aws.region is required"},
		{"empty aws bucket", "schemaVersion: 1\nprovider: aws\npreviewRetentionDays: 30\naws:\n  region: us-east-1\n  bucket: '  '\n", "aws.bucket is required"},
		{"cloudflare http base", "schemaVersion: 1\nprovider: cloudflare\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: http://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  apiTokenEnv: CF_TOKEN\n", "HTTPS origin"},
		{"cloudflare invalid session token variable", "schemaVersion: 1\nprovider: cloudflare\npreviewRetentionDays: 30\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  sessionTokenEnv: 'CF-SESSION'\n  apiTokenEnv: CF_TOKEN\n", "cloudflare.sessionTokenEnv must name an environment variable"},
		{"cloudflare incomplete registry reader credentials", "schemaVersion: 1\nprovider: cloudflare\npreviewRetentionDays: 30\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  registryReaderAccessKeyIdEnv: CF_REGISTRY_READ_ACCESS\n  apiTokenEnv: CF_TOKEN\n", "registryReaderAccessKeyIdEnv and registryReaderSecretAccessKeyEnv must be set together"},
		{"cloudflare invalid registry reader session token variable", "schemaVersion: 1\nprovider: cloudflare\npreviewRetentionDays: 30\ncloudflare:\n  accountId: 0123456789abcdef0123456789abcdef\n  bucket: pages\n  zoneId: abcdef0123456789abcdef0123456789\n  publicBaseURL: https://pages.example.com\n  accessKeyIdEnv: CF_ACCESS\n  secretAccessKeyEnv: CF_SECRET\n  registryReaderAccessKeyIdEnv: CF_REGISTRY_READ_ACCESS\n  registryReaderSecretAccessKeyEnv: CF_REGISTRY_READ_SECRET\n  registryReaderSessionTokenEnv: 'CF-SESSION'\n  apiTokenEnv: CF_TOKEN\n", "cloudflare.registryReaderSessionTokenEnv must name an environment variable"},
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

func TestResolveRemoteConfigPinsCommitAndFallsBackOnlyOnNotFound(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	configBytes := []byte("schemaVersion: 1\nprovider: aws\npreviewRetentionDays: 30\naws:\n  region: us-west-2\n  bucket: pages-prod\n  distributionId: E123\n")
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
	resolved, err := resolver.Resolve(t.Context(), "github://acme/admin")
	if err != nil {
		t.Fatalf("Resolve(remote) error = %v", err)
	}
	if resolved.CommitSHA != sha || resolved.Config.Provider != "aws" || !strings.Contains(resolved.Locator, "ref="+sha) {
		t.Fatalf("resolved config = %+v, want pinned commit and AWS target", resolved)
	}
	if !reflect.DeepEqual(resolved.Config, localResolved.Config) {
		t.Fatalf("local and remote config differ:\nlocal:  %+v\nremote: %+v", localResolved.Config, resolved.Config)
	}
	if _, err := os.Stat(filepath.Join(satellite, "sites.yaml")); !os.IsNotExist(err) {
		t.Fatalf("satellite test unexpectedly has admin manifest: stat error = %v", err)
	}
	if len(requests) != 4 || !strings.Contains(requests[3], "ref="+sha) {
		t.Fatalf("GitHub requests = %v, want metadata, commit, default-file 404 and fallback pinned to %s", requests, sha)
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
