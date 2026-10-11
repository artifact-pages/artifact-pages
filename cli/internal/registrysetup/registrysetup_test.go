package registrysetup

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

const cloudflareConfig = `schemaVersion: 1
provider: cloudflare
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  bucket: pages
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.com
  accessKeyIdEnv: CF_ACCESS
  secretAccessKeyEnv: CF_SECRET
  sessionTokenEnv: CF_SESSION
  registryReaderAccessKeyIdEnv: CF_READER_ACCESS
  registryReaderSecretAccessKeyEnv: CF_READER_SECRET
  registryReaderSessionTokenEnv: CF_READER_SESSION
  apiTokenEnv: CF_API_TOKEN
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: docs/public
`

const awsConfig = `schemaVersion: 1
provider: aws
aws:
  accountId: "123456789012"
  region: us-east-1
  bucket: pages
  distributionId: E123456789
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: docs/public
  guide:
    name: Guide
    repository: acme/guide
    sourcePath: public
`

var generatedYAML = []string{
	".github/workflows/publish-site.yml",
	".github/workflows/preview-site.yml",
	".github/workflows/registry.yml",
	".github/actions/site-sync/action.yml",
}

func writeFixture(t *testing.T, root, configText, terraformText string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte(configText), 0o600); err != nil {
		t.Fatal(err)
	}
	if terraformText != "" {
		if err := os.WriteFile(filepath.Join(root, "satellite-role-arns.json"), []byte(terraformText), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func runFixture(t *testing.T, root string, provider string, check bool) (string, error) {
	t.Helper()
	var output bytes.Buffer
	options := Options{Directory: root, Repository: "acme/admin", Check: check, Output: &output}
	if provider == "aws" {
		options.TerraformOutput = "satellite-role-arns.json"
	}
	err := Run(options)
	return output.String(), err
}

func generatedSnapshot(t *testing.T, root string, provider string) map[string][]byte {
	t.Helper()
	paths := append([]string(nil), generatedYAML...)
	if provider == "aws" {
		paths = append(paths, ".github/actions/site-sync/aws-roles.json")
	}
	snapshot := make(map[string][]byte, len(paths))
	for _, path := range paths {
		contents, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(path)))
		if err != nil {
			t.Fatalf("read generated %s: %v", path, err)
		}
		snapshot[path] = contents
	}
	return snapshot
}

func TestCloudflareGenerationIsDeterministicCheckableAndLocal(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, cloudflareConfig, "")
	t.Setenv("CF_API_TOKEN", "secret-value-must-not-be-read-or-printed")
	output, err := runFixture(t, root, "cloudflare", false)
	if err != nil {
		t.Fatalf("generate Cloudflare files: %v", err)
	}
	if !strings.Contains(output, "does not call GitHub") || !strings.Contains(output, "gh secret set CF_API_TOKEN --repo acme/admin --env production") || strings.Contains(output, "secret-value-must-not-be-read-or-printed") {
		t.Fatalf("manual steps missing or unsafe: %s", output)
	}
	snapshot := generatedSnapshot(t, root, "cloudflare")
	for _, path := range generatedYAML {
		var value map[string]any
		if err := yaml.Unmarshal(snapshot[path], &value); err != nil {
			t.Errorf("generated YAML %s is invalid: %v", path, err)
		}
		if !strings.Contains(string(snapshot[path]), "CLI v0.3.0") {
			t.Errorf("generated YAML %s does not record the generating CLI version", path)
		}
	}
	publish := string(snapshot[".github/workflows/publish-site.yml"])
	preview := string(snapshot[".github/workflows/preview-site.yml"])
	registry := string(snapshot[".github/workflows/registry.yml"])
	action := string(snapshot[".github/actions/site-sync/action.yml"])
	for _, expected := range []string{
		"required: true",
		"default: ''",
		"inputs.environment != ''",
		"inputs.environment == ''",
		"environment:",
		"CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}",
		"CF_READER_SECRET: ${{ secrets.CF_READER_SECRET }}",
	} {
		if !strings.Contains(publish, expected) && !strings.Contains(registry, expected) {
			t.Errorf("Cloudflare output missing %q", expected)
		}
	}
	if !strings.Contains(preview, "github.event.pull_request.head.repo.full_name == github.repository") {
		t.Fatal("preview workflow does not guard fork pull requests")
	}
	if !strings.Contains(registry, "github.event_name != 'pull_request' && 'production' || ''") {
		t.Fatal("registry workflow does not omit the production environment for pull-request dry-runs")
	}
	for name, contents := range map[string]string{"publish": publish, "preview": preview, "registry": registry, "action": action} {
		if strings.Contains(contents, "github-token") || strings.Contains(contents, "inputs.github-token") {
			t.Errorf("%s template includes the retired GitHub token input", name)
		}
	}
	if !strings.Contains(registry, "push:refs/heads/main") || !strings.Contains(registry, "workflow_dispatch:refs/heads/main") {
		t.Fatal("registry Action is not restricted to the default branch")
	}
	if !strings.Contains(action, "config: ${{ github.action_path }}/../../../artifact-pages.yaml") {
		t.Fatal("site-sync does not pass the config from its own admin commit")
	}
	for _, reference := range []string{
		"artifact-pages/publish-action@d59b7eceb7431c998bd2338eede1137081a141a2 # v0.1.0",
		"artifact-pages/preview-action@9961a1de43f1ac7e6deb6598b9cfbed9fdab7acb # v0.1.0",
		"artifact-pages/registry-action@c5edcfaa4ae9a479cb52b3489daa8925cf5eec29 # v0.1.0",
	} {
		if !strings.Contains(action+registry, reference) {
			t.Errorf("generated files missing pinned Action %q", reference)
		}
	}

	if _, err := runFixture(t, root, "cloudflare", false); err != nil {
		t.Fatalf("second generation: %v", err)
	}
	second := generatedSnapshot(t, root, "cloudflare")
	if !equalSnapshot(snapshot, second) {
		t.Fatal("second generation changed output bytes")
	}
	if _, err := runFixture(t, root, "cloudflare", true); err != nil {
		t.Fatalf("check generated Cloudflare files: %v", err)
	}
	path := filepath.Join(root, ".github/workflows/publish-site.yml")
	if err := os.WriteFile(path, append(snapshot[".github/workflows/publish-site.yml"], []byte("# drift\n")...), 0o644); err != nil {
		t.Fatal(err)
	}
	drifted, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runFixture(t, root, "cloudflare", true); !IsDrift(err) {
		t.Fatalf("--check error = %v, want drift", err)
	}
	afterCheck, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(afterCheck, drifted) {
		t.Fatalf("--check modified drifted file: err=%v", err)
	}
}

func TestPreviewWorkflowOmitsAPITokenWhenConfigNamesR2Credentials(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, cloudflareConfig, "")
	if _, err := runFixture(t, root, "cloudflare", false); err != nil {
		t.Fatalf("generate Cloudflare files: %v", err)
	}
	snapshot := generatedSnapshot(t, root, "cloudflare")
	preview := string(snapshot[".github/workflows/preview-site.yml"])
	for _, name := range []string{"CF_ACCESS", "CF_SECRET"} {
		if !strings.Contains(preview, name+": ${{ secrets."+name+" }}") {
			t.Errorf("preview workflow does not map its configured R2 credential %s", name)
		}
	}
	if strings.Contains(preview, "CF_API_TOKEN") {
		t.Fatal("preview workflow maps the API-only token despite explicit R2 credential variable names")
	}
	for _, path := range []string{".github/workflows/publish-site.yml", ".github/workflows/registry.yml"} {
		if !strings.Contains(string(snapshot[path]), "CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}") {
			t.Errorf("%s does not retain the Cloudflare API token mapping", path)
		}
	}
}

func TestPreviewWorkflowRetainsAPITokenCredentialDerivationFallback(t *testing.T) {
	root := t.TempDir()
	config := strings.ReplaceAll(cloudflareConfig, "  accessKeyIdEnv: CF_ACCESS\n", "")
	config = strings.ReplaceAll(config, "  secretAccessKeyEnv: CF_SECRET\n", "")
	writeFixture(t, root, config, "")
	if _, err := runFixture(t, root, "cloudflare", false); err != nil {
		t.Fatalf("generate Cloudflare files: %v", err)
	}
	preview := string(generatedSnapshot(t, root, "cloudflare")[".github/workflows/preview-site.yml"])
	for _, name := range []string{"CF_R2_ACCESS_KEY_ID", "CF_R2_SECRET_ACCESS_KEY", "CF_API_TOKEN"} {
		if !strings.Contains(preview, name+": ${{ secrets."+name+" }}") {
			t.Errorf("preview workflow does not preserve the token-only credential fallback variable %s", name)
		}
	}
}

func TestAWSGenerationUsesPlainTerraformRoleMapAndSafeLookup(t *testing.T) {
	root := t.TempDir()
	terraformOutput := `{"docs":"arn:aws:iam::123456789012:role/site/docs","guide":"arn:aws:iam::123456789012:role/site/guide"}`
	writeFixture(t, root, awsConfig, terraformOutput)
	if _, err := runFixture(t, root, "aws", false); err != nil {
		t.Fatalf("generate AWS files: %v", err)
	}
	snapshot := generatedSnapshot(t, root, "aws")
	var roles map[string]string
	if err := json.Unmarshal(snapshot[".github/actions/site-sync/aws-roles.json"], &roles); err != nil {
		t.Fatalf("generated AWS role map is not JSON: %v", err)
	}
	if len(roles) != 2 || roles["docs"] != "arn:aws:iam::123456789012:role/site/docs" || roles["guide"] == "" {
		t.Fatalf("generated role map = %#v", roles)
	}
	action := string(snapshot[".github/actions/site-sync/action.yml"])
	for _, expected := range []string{
		"jq -er --arg site \"$ARTIFACT_PAGES_SITE\"",
		"no AWS role is registered for site",
		"role-to-assume: ${{ steps.role.outputs['role-arn'] }}",
		"aws-actions/configure-aws-credentials@e1253824e5c10ff9df46874f81ed3ec929e19cfd # v6.3.0",
		"aws-region: us-east-1",
		"config: ${{ github.action_path }}/../../../artifact-pages.yaml",
	} {
		if !strings.Contains(action, expected) {
			t.Errorf("AWS composite action missing %q", expected)
		}
	}
	if strings.Contains(action, "${{ inputs.site }}\" ") || strings.Contains(action, "github-token") {
		t.Fatal("AWS site input is interpolated into shell or uses github-token")
	}
	var workflow map[string]any
	if err := yaml.Unmarshal(snapshot[".github/workflows/registry.yml"], &workflow); err != nil {
		t.Fatalf("generated AWS registry workflow is invalid YAML: %v", err)
	}
	if !strings.Contains(string(snapshot[".github/workflows/registry.yml"]), "vars.ARTIFACT_PAGES_REGISTRY_ADMIN_ROLE_ARN") {
		t.Fatal("AWS registry workflow does not use the admin role variable")
	}
}

func TestAWSRoleMapRejectsInvalidCoverageAndDuplicateKeys(t *testing.T) {
	tests := []struct {
		name string
		json string
		want string
	}{
		{"missing registered role", `{"docs":"arn:aws:iam::123456789012:role/site/docs"}`, `no role for registered site "guide"`},
		{"unregistered role", `{"docs":"arn:aws:iam::123456789012:role/site/docs","guide":"arn:aws:iam::123456789012:role/site/guide","other":"arn:aws:iam::123456789012:role/site/other"}`, `unregistered site "other"`},
		{"invalid ARN", `{"docs":"not-an-arn","guide":"arn:aws:iam::123456789012:role/site/guide"}`, `must be an AWS IAM role ARN`},
		{"wrong account", `{"docs":"arn:aws:iam::999999999999:role/site/docs","guide":"arn:aws:iam::123456789012:role/site/guide"}`, `different AWS account`},
		{"duplicate key", `{"docs":"arn:aws:iam::123456789012:role/site/docs","docs":"arn:aws:iam::123456789012:role/site/other","guide":"arn:aws:iam::123456789012:role/site/guide"}`, `duplicate site "docs"`},
		{"wrapper object", `{"value":{"docs":"arn:aws:iam::123456789012:role/site/docs"}}`, `must be a string role ARN`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			writeFixture(t, root, awsConfig, test.json)
			_, err := runFixture(t, root, "aws", false)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("generation error = %v, want substring %q", err, test.want)
			}
			if _, err := os.Stat(filepath.Join(root, ".github")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid role map created output tree: stat err=%v", err)
			}
		})
	}
}

func TestGenerationRefusesUnmanagedFilesAndSymlinkEscapesBeforeWriting(t *testing.T) {
	t.Run("unmanaged output", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, root, cloudflareConfig, "")
		unmanaged := filepath.Join(root, ".github/workflows/registry.yml")
		if err := os.MkdirAll(filepath.Dir(unmanaged), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(unmanaged, []byte("operator owned\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := runFixture(t, root, "cloudflare", false)
		if err == nil || !strings.Contains(err.Error(), "refusing to overwrite unmanaged") {
			t.Fatalf("generation error = %v, want unmanaged-file refusal", err)
		}
		if _, err := os.Stat(filepath.Join(root, ".github/actions")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("generation partially created other paths before refusal: stat err=%v", err)
		}
		contents, err := os.ReadFile(unmanaged)
		if err != nil || string(contents) != "operator owned\n" {
			t.Fatalf("unmanaged file changed: %q, err=%v", contents, err)
		}
	})

	t.Run("symlink directory", func(t *testing.T) {
		root := t.TempDir()
		outside := t.TempDir()
		writeFixture(t, root, cloudflareConfig, "")
		if err := os.Symlink(outside, filepath.Join(root, ".github")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		_, err := runFixture(t, root, "cloudflare", false)
		if err == nil || !strings.Contains(err.Error(), "symlink directory") {
			t.Fatalf("generation error = %v, want symlink refusal", err)
		}
		entries, err := os.ReadDir(outside)
		if err != nil || len(entries) != 0 {
			t.Fatalf("generation wrote outside root: entries=%v err=%v", entries, err)
		}
	})

	t.Run("symlink generated file", func(t *testing.T) {
		root := t.TempDir()
		outside := filepath.Join(t.TempDir(), "outside.yml")
		if err := os.WriteFile(outside, []byte("protected\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		writeFixture(t, root, cloudflareConfig, "")
		target := filepath.Join(root, ".github/workflows/publish-site.yml")
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, target); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		_, err := runFixture(t, root, "cloudflare", false)
		if err == nil || !strings.Contains(err.Error(), "not a symlink or directory") {
			t.Fatalf("generation error = %v, want generated-file symlink refusal", err)
		}
		contents, err := os.ReadFile(outside)
		if err != nil || string(contents) != "protected\n" {
			t.Fatalf("external file changed: %q, err=%v", contents, err)
		}
	})
}

func TestConfigAndRepositoryInputsAreExplicitAndSafe(t *testing.T) {
	t.Run("missing sites mapping", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, root, strings.Replace(cloudflareConfig, "sites:\n  docs:\n    name: Documentation\n    repository: acme/docs\n    sourcePath: docs/public\n", "", 1), "")
		_, err := runFixture(t, root, "cloudflare", false)
		if err == nil || !strings.Contains(err.Error(), "include a sites mapping") {
			t.Fatalf("generation error = %v", err)
		}
	})
	t.Run("empty sites is accepted", func(t *testing.T) {
		root := t.TempDir()
		configText := strings.Replace(cloudflareConfig, "sites:\n  docs:\n    name: Documentation\n    repository: acme/docs\n    sourcePath: docs/public\n", "sites: {}\n", 1)
		if err := os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte(configText), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := runFixture(t, root, "cloudflare", false); err != nil {
			t.Fatalf("empty explicit sites mapping rejected: %v", err)
		}
	})
	t.Run("remote config locator rejected", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, root, cloudflareConfig, "")
		var output bytes.Buffer
		err := Run(Options{Directory: root, ConfigPath: "github://acme/admin/artifact-pages.yaml?ref=main", Repository: "acme/admin", Output: &output})
		if err == nil || !strings.Contains(err.Error(), "local file path") {
			t.Fatalf("remote config error = %v", err)
		}
	})
	t.Run("config outside directory rejected", func(t *testing.T) {
		root := t.TempDir()
		external := filepath.Join(t.TempDir(), "config.yaml")
		writeFixture(t, root, cloudflareConfig, "")
		if err := os.WriteFile(external, []byte(cloudflareConfig), 0o600); err != nil {
			t.Fatal(err)
		}
		var output bytes.Buffer
		err := Run(Options{Directory: root, ConfigPath: external, Repository: "acme/admin", Output: &output})
		if err == nil || !strings.Contains(err.Error(), "inside the --directory root") {
			t.Fatalf("external config error = %v", err)
		}
	})
	t.Run("config parent symlink rejected", func(t *testing.T) {
		root := t.TempDir()
		external := t.TempDir()
		writeFixture(t, root, cloudflareConfig, "")
		if err := os.WriteFile(filepath.Join(external, "config.yaml"), []byte(cloudflareConfig), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(external, filepath.Join(root, "config-link")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		var output bytes.Buffer
		err := Run(Options{Directory: root, ConfigPath: "config-link/config.yaml", Repository: "acme/admin", Output: &output})
		if err == nil || !strings.Contains(err.Error(), "must not traverse a symlink") {
			t.Fatalf("symlinked config path error = %v", err)
		}
	})
	t.Run("repository argument injection rejected", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, root, cloudflareConfig, "")
		var output bytes.Buffer
		err := Run(Options{Directory: root, Repository: "--help/evil;echo", Output: &output})
		if err == nil || !strings.Contains(err.Error(), "OWNER/REPOSITORY") {
			t.Fatalf("invalid repository error = %v", err)
		}
	})
}

func TestManualStepsUseCustomCloudflareSecretNames(t *testing.T) {
	root := t.TempDir()
	config := strings.Replace(cloudflareConfig, "apiTokenEnv: CF_API_TOKEN", "apiTokenEnv: CF_CUSTOM_TOKEN", 1)
	writeFixture(t, root, config, "")
	output, err := runFixture(t, root, "cloudflare", false)
	if err != nil {
		t.Fatalf("generate Cloudflare custom-secret files: %v", err)
	}
	if !strings.Contains(output, "gh secret set CF_CUSTOM_TOKEN --repo OWNER/SITE_REPOSITORY") {
		t.Fatalf("manual steps omitted the configured API-token secret name: %s", output)
	}
}

func TestManualStepsProvisionAdminRepositorySecretsForRegistryPullRequestDryRuns(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, cloudflareConfig, "")
	output, err := runFixture(t, root, "cloudflare", false)
	if err != nil {
		t.Fatalf("generate Cloudflare files: %v", err)
	}
	if !strings.Contains(output, "Registry pull-request dry-runs do not select an environment") {
		t.Fatalf("manual steps do not explain the registry pull-request environment behavior: %s", output)
	}
	for _, name := range []string{"CF_API_TOKEN", "CF_READER_SECRET"} {
		if !strings.Contains(output, "gh secret set "+name+" --repo acme/admin\n") {
			t.Errorf("manual steps do not provision admin %s at repository scope: %s", name, output)
		}
		if !strings.Contains(output, "gh secret set "+name+" --repo acme/admin --env production") {
			t.Errorf("manual steps omit the optional production override for %s: %s", name, output)
		}
	}
	if !strings.Contains(output, "Optional: production environment secrets of the same names override repository values") {
		t.Fatalf("manual steps do not identify production environment secrets as optional overrides: %s", output)
	}
}

func TestRoleFileChangeRequiresMatchingGeneratorMetadata(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, awsConfig, `{"docs":"arn:aws:iam::123456789012:role/site/docs","guide":"arn:aws:iam::123456789012:role/site/guide"}`)
	if _, err := runFixture(t, root, "aws", false); err != nil {
		t.Fatal(err)
	}
	rolesPath := filepath.Join(root, ".github/actions/site-sync/aws-roles.json")
	if err := os.WriteFile(rolesPath, []byte(`{"docs":"arn:aws:iam::123456789012:role/site/manual","guide":"arn:aws:iam::123456789012:role/site/guide"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := runFixture(t, root, "aws", false)
	if err == nil || !strings.Contains(err.Error(), "refusing to overwrite unmanaged") {
		t.Fatalf("manual roles edit error = %v", err)
	}
}

func TestGeneratedActionMetadataDoesNotAuthorizeUnmanagedOutputs(t *testing.T) {
	t.Run("unmanaged workflow despite generated action metadata", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, root, awsConfig, `{"docs":"arn:aws:iam::123456789012:role/site/docs","guide":"arn:aws:iam::123456789012:role/site/guide"}`)
		if _, err := runFixture(t, root, "aws", false); err != nil {
			t.Fatal(err)
		}
		unmanaged := filepath.Join(root, ".github/workflows/preview-site.yml")
		if err := os.WriteFile(unmanaged, []byte("operator owned\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		_, err := runFixture(t, root, "aws", false)
		if err == nil || !strings.Contains(err.Error(), "refusing to overwrite unmanaged or manually edited file .github/workflows/preview-site.yml") {
			t.Fatalf("generated action metadata authorized an unrelated overwrite: %v", err)
		}
		contents, readErr := os.ReadFile(unmanaged)
		if readErr != nil || string(contents) != "operator owned\n" {
			t.Fatalf("unmanaged workflow changed: %q, err=%v", contents, readErr)
		}
	})
	t.Run("symlinked role map despite generated action metadata", func(t *testing.T) {
		root := t.TempDir()
		writeFixture(t, root, awsConfig, `{"docs":"arn:aws:iam::123456789012:role/site/docs","guide":"arn:aws:iam::123456789012:role/site/guide"}`)
		if _, err := runFixture(t, root, "aws", false); err != nil {
			t.Fatal(err)
		}
		outside := filepath.Join(t.TempDir(), "roles.json")
		if err := os.WriteFile(outside, []byte("operator owned\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		roles := filepath.Join(root, ".github/actions/site-sync/aws-roles.json")
		if err := os.Remove(roles); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(outside, roles); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		_, err := runFixture(t, root, "aws", false)
		if err == nil || !strings.Contains(err.Error(), "must be a regular file, not a symlink or directory") {
			t.Fatalf("generated action metadata authorized writing through role-map symlink: %v", err)
		}
		contents, readErr := os.ReadFile(outside)
		if readErr != nil || string(contents) != "operator owned\n" {
			t.Fatalf("symlink target changed: %q, err=%v", contents, readErr)
		}
	})
}

func equalSnapshot(left, right map[string][]byte) bool {
	if len(left) != len(right) {
		return false
	}
	for path, contents := range left {
		if !bytes.Equal(contents, right[path]) {
			return false
		}
	}
	return true
}

func TestManagedDigestMatchesGeneratedBody(t *testing.T) {
	first := []byte("# Code generated by artifact-pages registry setup (CLI v0.2.0); DO NOT EDIT.\nbody\n")
	generated := addManagedDigest(first)
	lines := bytes.SplitN(generated, []byte("\n"), 3)
	if len(lines) != 3 || string(lines[1]) != "# managed-sha256: "+sha256Hex([]byte("body\n")) {
		t.Fatalf("generated digest header = %q", generated)
	}
	if !managedOutput(".github/workflows/a.yml", generated, nil, "not-applicable", nil) {
		t.Fatal("generated output was not recognized as managed")
	}
	modified := append(append([]byte(nil), generated...), []byte("edit\n")...)
	if managedOutput(".github/workflows/a.yml", modified, nil, "not-applicable", nil) {
		t.Fatal("manually edited output was recognized as managed")
	}
}
