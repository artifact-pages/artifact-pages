package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	previewrecords "github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
	"github.com/artifact-pages/artifact-pages/cli/internal/registry"
	"github.com/artifact-pages/artifact-pages/cli/internal/version"
)

const (
	cliProcessHelperEnv = "ARTIFACT_PAGES_CLI_TEST_HELPER"
	cliProcessArgsEnv   = "ARTIFACT_PAGES_CLI_TEST_ARGS"
)

const localUnregisterManifest = `schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
`

const localRegistryBeforeUnregister = `schemaVersion: 1
provider: local
local:
  root: .local/storage
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
  sre:
    name: SRE & Platform
    repository: acme/sre
    sourcePath: docs/artifacts
`

func expectedVerificationSites() map[string]registry.Site {
	return map[string]registry.Site{
		"smoke": {
			Name:        "Actions smoke",
			Description: "Verification fixture published from the OSS repository.",
			Repository:  "artifact-pages/artifact-pages",
			SourcePath:  "fixtures/actions-smoke/site",
		},
		"verify-scale-10": {
			Name: "Scale verification · 10 files", Description: "Deterministic publisher fixture.",
			Repository: "artifact-pages/artifact-pages", SourcePath: "fixtures/scale/sites/verify-scale-10/source",
		},
		"verify-scale-100": {
			Name: "Scale verification · 100 files", Description: "Deterministic publisher fixture.",
			Repository: "artifact-pages/artifact-pages", SourcePath: "fixtures/scale/sites/verify-scale-100/source",
		},
		"verify-scale-1000": {
			Name: "Scale verification · 1,000 files", Description: "Deterministic publisher fixture.",
			Repository: "artifact-pages/artifact-pages", SourcePath: "fixtures/scale/sites/verify-scale-1000/source",
		},
		"verify-scale-5000": {
			Name: "Scale verification · 5,000 files", Description: "Deterministic publisher fixture.",
			Repository: "artifact-pages/artifact-pages", SourcePath: "fixtures/scale/sites/verify-scale-5000/source",
		},
		"verify-scale-10000": {
			Name: "Scale verification · 10,000 files", Description: "Deterministic publisher fixture.",
			Repository: "artifact-pages/artifact-pages", SourcePath: "fixtures/scale/sites/verify-scale-10000/source",
		},
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller could not locate main_test.go")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filename), "../../.."))
}

func assertVerificationCloudflareTarget(t *testing.T, config deploymentconfig.DeploymentConfig) {
	t.Helper()
	if config.Provider != "cloudflare" || config.Cloudflare == nil || config.Local != nil {
		t.Fatalf("effective target = provider %q, cloudflare=%+v, local=%+v; want Cloudflare only", config.Provider, config.Cloudflare, config.Local)
	}
	target := config.Cloudflare
	if target.AccountID != "9ac354c8aa31d424224d8c4f3aa8ba2a" || target.ZoneID != "b647a1ef28dde558fa8b80b50ad0c040" || target.Bucket != "artifact-pages-verify" || target.PublicBaseURL != "https://artifact-pages.stream" {
		t.Fatalf("Cloudflare verification target = %+v; want artifact-pages-verify at https://artifact-pages.stream", target)
	}
	if target.AccessKeyIDEnv != "CF_VERIFY_R2_ACCESS_KEY_ID" || target.SecretAccessKeyEnv != "CF_VERIFY_R2_SECRET_ACCESS_KEY" || target.APITokenEnv != "CF_VERIFY_API_TOKEN" {
		t.Fatalf("Cloudflare credential variable names = %q, %q, %q; want the CF_VERIFY_* variables", target.AccessKeyIDEnv, target.SecretAccessKeyEnv, target.APITokenEnv)
	}
}

func TestVerificationConfigsResolveCompleteLocalAndCloudflareTargets(t *testing.T) {
	root := repositoryRoot(t)
	readConfig := func(name string) []byte {
		t.Helper()
		contents, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return contents
	}
	wantSites := expectedVerificationSites()

	localBytes := readConfig("artifact-pages.yaml")
	local, err := deploymentconfig.Parse(localBytes)
	if err != nil {
		t.Fatalf("parse artifact-pages.yaml: %v", err)
	}
	if local.Provider != "local" || local.Local == nil || local.Local.Root != ".local/verify/storage" {
		t.Fatalf("local verification target = provider %q, local=%+v; want .local/verify/storage", local.Provider, local.Local)
	}
	if !reflect.DeepEqual(local.Sites, wantSites) {
		t.Fatalf("local sites = %+v; want complete smoke + scale mapping %+v", local.Sites, wantSites)
	}

	fixtureLocal, err := deploymentconfig.Parse(readConfig("fixtures/scale/publisher.yaml"))
	if err != nil {
		t.Fatalf("parse fixtures/scale/publisher.yaml: %v", err)
	}
	if fixtureLocal.Provider != "local" || fixtureLocal.Local == nil || fixtureLocal.Local.Root != ".local/scale-fixtures/storage" || !reflect.DeepEqual(fixtureLocal.Sites, wantSites) {
		t.Fatalf("isolated fixture config = %+v; want complete verification sites at .local/scale-fixtures/storage", fixtureLocal)
	}

	verify, err := deploymentconfig.Parse(readConfig("artifact-pages.verify.yaml"))
	if err != nil {
		t.Fatalf("parse artifact-pages.verify.yaml: %v", err)
	}
	assertVerificationCloudflareTarget(t, verify)
	if !reflect.DeepEqual(verify.Sites, wantSites) {
		t.Fatalf("single-file verify sites = %+v; want complete smoke + scale mapping %+v", verify.Sites, wantSites)
	}

	// The ignored Cloudflare file is a target-only layer; when present in a
	// developer checkout it must inherit the complete site mapping from the base.
	cloudLayer, err := os.ReadFile(filepath.Join(root, "artifact-pages.cloudflare.yaml"))
	if err == nil {
		effective, err := deploymentconfig.ParseLayers([][]byte{localBytes, cloudLayer})
		if err != nil {
			t.Fatalf("resolve artifact-pages.yaml + artifact-pages.cloudflare.yaml: %v", err)
		}
		assertVerificationCloudflareTarget(t, effective)
		if !reflect.DeepEqual(effective.Sites, wantSites) {
			t.Fatalf("layered sites = %+v; want inherited complete mapping %+v", effective.Sites, wantSites)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read ignored artifact-pages.cloudflare.yaml: %v", err)
	}
}

func TestRunRootHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(--help) error = %v", err)
	}
	help := stdout.String()
	if !strings.Contains(help, "artifact-pages <command>") {
		t.Errorf("root help does not show the standalone CLI usage:\n%s", stdout.String())
	}
	for _, expected := range []string{"registry sync", "site sync", "app deploy", "app remove", "lock inspect|recover"} {
		if !strings.Contains(help, expected) {
			t.Errorf("root help is missing %q:\n%s", expected, help)
		}
	}
	if strings.Contains(help, "registry publish") {
		t.Errorf("root help still describes registry registration as publication:\n%s", help)
	}
	if strings.Contains(help, "admin apply") || strings.Contains(help, "admin registry build") {
		t.Errorf("root help exposes an unconfirmed admin command:\n%s", help)
	}
	if err := run(t.Context(), []string{"admin", "apply"}, &stdout, &stderr); err == nil {
		t.Error("run(admin apply) succeeded; want removed namespace to be rejected")
	}
}

func TestRunRegistryPublishCommandNameIsRejected(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"registry", "publish"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), `unknown registry command "publish"`) {
		t.Fatalf("run(registry publish) error = %v, want an unknown-command error", err)
	}
}

func TestRemovedOperationAliasesAreRejected(t *testing.T) {
	for _, args := range [][]string{
		{"registry", "register"},
		{"registry", "unregister"},
		{"site", "publish"},
	} {
		var stdout, stderr bytes.Buffer
		err := run(t.Context(), args, &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "unknown") {
			t.Errorf("run(%v) error = %v, want an unknown-command error", args, err)
		}
	}
}

func TestRunBuildHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"index", "build", "--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(index build --help) error = %v", err)
	}
	for _, expected := range []string{"artifact-pages index build [options]", "--site ID", "--source DIR", "--out DIR"} {
		if !strings.Contains(stderr.String(), expected) {
			t.Errorf("build help is missing %q:\n%s", expected, stderr.String())
		}
	}
}

func TestRunBuildRequiresSource(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"index", "build", "--site", "sre"}, &stdout, &stderr)
	if err == nil || err.Error() != "--source is required" {
		t.Fatalf("run(index build without source) error = %v, want --source is required", err)
	}
}

func TestRunRegistryBuildIsNotAPublicCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"registry", "build"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), `unknown registry command "build"`) {
		t.Fatalf("run(registry build) error = %v, want an unknown-command error", err)
	}
	if strings.Contains(stdout.String()+stderr.String(), "admin registry build") {
		t.Fatalf("registry build error exposed the removed command:\nstdout=%s\nstderr=%s", stdout.String(), stderr.String())
	}
}

func TestRunRegistryRegisterHelpExplainsConfigReconciliation(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"registry", "sync", "--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(registry sync --help) error = %v", err)
	}
	help := stdout.String() + stderr.String()
	for _, expected := range []string{
		"artifact-pages registry sync",
		"Reconcile the complete sites mapping",
		"omitted sites are removed from discovery and their projection is cleaned on apply",
	} {
		if !strings.Contains(help, expected) {
			t.Errorf("registry sync help is missing %q:\n%s", expected, help)
		}
	}
	if strings.Contains(help, "registry publish") || strings.Contains(help, "publish that projection") {
		t.Errorf("registry sync help still describes registration as publication:\n%s", help)
	}
}

func TestRunRegistryRegisterReadsSelectedConfigAndDryRunDoesNotCreateStorage(t *testing.T) {
	root := t.TempDir()
	previousDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previousDirectory) })
	config := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\nsites:\n  sre:\n    name: SRE & Platform\n    repository: acme/sre\n    sourcePath: docs/artifacts\n"
	if err := os.WriteFile("deployment.yaml", []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"registry", "sync", "--config", "deployment.yaml", "--format", "json"}
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), append(args, "--dry-run"), &stdout, &stderr); err != nil {
		t.Fatalf("registry sync dry-run error = %v; stderr=%s", err, stderr.String())
	}
	var planned struct {
		Operation       string             `json:"operation"`
		Outcome         string             `json:"outcome"`
		Changes         []publisher.Change `json:"changes"`
		RegistryUpdated *bool              `json:"registryUpdated"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &planned); err != nil {
		t.Fatalf("decode registry sync dry-run JSON: %v; output=%s", err, stdout.String())
	}
	if planned.Operation != "registry sync" || planned.Outcome != "planned" || planned.RegistryUpdated == nil || *planned.RegistryUpdated {
		t.Fatalf("registry sync dry-run result = %+v, want a plan with registryUpdated=false", planned)
	}
	wantChanges := []publisher.Change{
		{Action: "invalidate", Path: "/_indexes/sites.json"},
		{Action: "create", Path: "_indexes/sites.json"},
		{Action: "create", Path: "_indexes/sites.json#sites/sre"},
	}
	if !reflect.DeepEqual(planned.Changes, wantChanges) {
		t.Fatalf("registry sync dry-run changes = %+v, want %+v", planned.Changes, wantChanges)
	}
	if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
		t.Fatalf("dry-run created local storage: stat error = %v", err)
	}

	stdout.Reset()
	stderr.Reset()
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("registry sync error = %v; stderr=%s", err, stderr.String())
	}
	var applied struct {
		Operation       string `json:"operation"`
		Outcome         string `json:"outcome"`
		RegistryUpdated *bool  `json:"registryUpdated"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &applied); err != nil {
		t.Fatalf("decode registry sync JSON: %v; output=%s", err, stdout.String())
	}
	if applied.Operation != "registry sync" || applied.Outcome != "synced" || applied.RegistryUpdated == nil || !*applied.RegistryUpdated {
		t.Fatalf("registry sync result = %+v, want registered and registryUpdated=true", applied)
	}
	projection, err := os.ReadFile(filepath.Join(root, ".local", "storage", "_indexes", "sites.json"))
	if err != nil || !strings.Contains(string(projection), `"id": "sre"`) {
		t.Fatalf("config sites were not projected to local storage: contents=%s err=%v", projection, err)
	}
}

func TestRegistryCommandsRequireSitesMapping(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "deployment.yaml")
	targetOnly := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n"
	if err := os.WriteFile(configPath, []byte(targetOnly), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"registry", "sync", "--config", "deployment.yaml", "--format", "json"},
	} {
		stdout, stderr, exitCode := runCLIProcess(t, root, args)
		var failure struct {
			Outcome string `json:"outcome"`
			Error   string `json:"error"`
		}
		if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
			t.Fatalf("decode missing-sites failure for %v: %v; stdout=%s", args, err, stdout)
		}
		if exitCode != 2 || failure.Outcome != "failed" || !strings.Contains(failure.Error, "must include a sites mapping") {
			t.Fatalf("registry command %v without sites = exit %d; stdout=%s stderr=%s, want a config input error", args, exitCode, stdout, stderr)
		}
		if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
			t.Fatalf("registry command %v created storage without sites: stat error = %v", args, err)
		}
	}

	emptyConfig := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\nsites: {}\n"
	if err := os.WriteFile(configPath, []byte(emptyConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, exitCode := runCLIProcess(t, root, []string{"registry", "sync", "--config", "deployment.yaml", "--dry-run", "--format", "json"})
	var emptyResult publisher.Result
	if err := json.Unmarshal([]byte(stdout), &emptyResult); err != nil {
		t.Fatalf("decode empty-sites dry-run: %v; stdout=%s", err, stdout)
	}
	if exitCode != 0 || emptyResult.Outcome != "planned" {
		t.Fatalf("registry sync with explicit empty sites = exit %d; stdout=%s stderr=%s, want a valid dry-run", exitCode, stdout, stderr)
	}
}

func TestRunRegistryRegisterAcceptsOrderedConfigLayers(t *testing.T) {
	root := t.TempDir()
	base := `schemaVersion: 1
sites:
  en:
    name: English
    description: Product documentation
    repository: artifact-pages/artifact-pages
    sourcePath: docs/public/sites/en
`
	target := `schemaVersion: 1
provider: local
local:
  root: .local/storage
`
	if err := os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte(base), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "artifact-pages.local.yaml"), []byte(target), 0o600); err != nil {
		t.Fatal(err)
	}
	stdout, stderr, exitCode := runCLIProcess(t, root, []string{
		"registry", "sync",
		"--config", "artifact-pages.yaml",
		"--config", "artifact-pages.local.yaml",
		"--dry-run", "--format", "json",
	})
	var result publisher.Result
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("decode layered config result: %v; stdout=%s stderr=%s", err, stdout, stderr)
	}
	if exitCode != 0 || result.Operation != "registry sync" || result.Outcome != "planned" || len(result.Changes) != 3 {
		t.Fatalf("layered registry dry-run = exit %d, %+v; stderr=%s, want inherited site and local target", exitCode, result, stderr)
	}
	if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
		t.Fatalf("layered dry-run created local storage: stat error = %v", err)
	}
}

func TestPublishCommandHelpIsProviderNeutral(t *testing.T) {
	for _, args := range [][]string{{"site", "sync", "--help"}, {"app", "deploy", "--help"}} {
		var stdout, stderr bytes.Buffer
		if err := run(t.Context(), args, &stdout, &stderr); err != nil {
			t.Fatalf("run(%v) error = %v", args, err)
		}
		help := stdout.String() + stderr.String()
		if strings.Contains(help, "s3") || strings.Contains(help, "--bucket") || !strings.Contains(help, "--config LOCATOR") {
			t.Errorf("help for %v is not provider-neutral:\n%s", args, help)
		}
	}
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"site", "sync", "--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(site sync --help) error = %v", err)
	}
	if help := stdout.String() + stderr.String(); !strings.Contains(help, "stale preview references") {
		t.Errorf("site sync dry-run help does not mention stale preview references:\n%s", help)
	}
	stdout.Reset()
	stderr.Reset()
	if err := run(t.Context(), []string{"app", "deploy", "--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(app deploy --help) error = %v", err)
	}
	if help := stdout.String() + stderr.String(); !strings.Contains(help, "--dry-run") {
		t.Errorf("app deploy help does not expose the shared dry-run option:\n%s", help)
	}
}

func TestRunSitePublishUsesLocalConfiguredBackend(t *testing.T) {
	root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"site", "sync", "--site", "sre", "--source", "docs/artifacts"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(site sync) error = %v; stderr=%s", err, stderr.String())
	}
	artifact, err := os.ReadFile(filepath.Join(root, ".local", "storage", "_artifacts", "sre", "overview.html"))
	if err != nil || string(artifact) != "<title>Overview</title><h1>Overview</h1>" {
		t.Fatalf("published local artifact = %q, err=%v", artifact, err)
	}
	if !strings.Contains(stdout.String(), "Target    local · .local/storage") {
		t.Errorf("publish report should identify the configured local target: %q", stdout.String())
	}
}

func TestRunSitePublishDryRunAndNoOpAreMachineReadable(t *testing.T) {
	root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	storageRoot := filepath.Join(root, ".local", "storage")
	const staleHeadSHA = "1111111111111111111111111111111111111111"
	staleCatalog, err := previewrecords.EncodeCatalog(previewrecords.Catalog{
		SchemaVersion: previewrecords.SchemaVersion,
		Site:          "sre",
		Groups: []previewrecords.Group{{
			ID: "pr:42", Kind: "pull-request", HeadSHA: staleHeadSHA,
			PRURL: "https://github.com/acme/sre/pull/42", UpdatedAt: "2026-09-27T00:00:00Z",
			Documents: []previewrecords.Document{{Path: "review.html", Title: "Review", Format: "html"}},
		}},
		RevisionHistory: []previewrecords.GroupRevisionHistory{{
			GroupID: "pr:42", Revisions: []previewrecords.RevisionOwnership{{HeadSHA: staleHeadSHA, Files: []string{"review.html"}}},
		}},
	})
	if err != nil {
		t.Fatalf("encode stale preview catalog: %v", err)
	}
	staleCatalogPath := filepath.Join(storageRoot, "_previews", "sre", "catalog.json")
	if err := os.MkdirAll(filepath.Dir(staleCatalogPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleCatalogPath, staleCatalog, 0o600); err != nil {
		t.Fatal(err)
	}
	oldArtifactPath := filepath.Join(storageRoot, "_artifacts", "sre", "overview.html")
	staleArtifactPath := filepath.Join(storageRoot, "_artifacts", "sre", "stale.html")
	if err := os.MkdirAll(filepath.Dir(oldArtifactPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldArtifactPath, []byte("<title>Old</title>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staleArtifactPath, []byte("stale artifact"), 0o600); err != nil {
		t.Fatal(err)
	}
	beforeDryRun := snapshotFiles(t, storageRoot)

	args := []string{"site", "sync", "--site", "sre", "--source", "docs/artifacts", "--dry-run", "--format", "json"}
	stdout, stderr, exitCode := runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("site sync dry-run exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var planned struct {
		Operation      string             `json:"operation"`
		Outcome        string             `json:"outcome"`
		Site           string             `json:"site"`
		Changes        []publisher.Change `json:"changes"`
		FilesPublished int                `json:"filesPublished"`
		FilesRemoved   int                `json:"filesRemoved"`
		PreviewChanges []struct {
			Action  string `json:"action"`
			GroupID string `json:"groupId"`
			HeadSHA string `json:"headSha"`
			Reason  string `json:"reason"`
		} `json:"previewChanges"`
	}
	if err := json.Unmarshal([]byte(stdout), &planned); err != nil {
		t.Fatalf("decode site sync dry-run JSON: %v; output=%s", err, stdout)
	}
	wantChanges := []publisher.Change{
		{Action: "update", Path: "_artifacts/sre/overview.html"},
		{Action: "remove", Path: "_artifacts/sre/stale.html"},
		{Action: "create", Path: "_indexes/sre/index.json"},
		{Action: "create", Path: "_indexes/sre/meta.json"},
		{Action: "create", Path: "_indexes/sre/search/manifest.json"},
		{Action: "create", Path: "_indexes/sre/search/root-a9b445d38284b9a0f4995534afe000d1e3e8ee30b2c66db9866be64b37f1e0c7.gz"},
	}
	if planned.Operation != "site sync" || planned.Outcome != "planned" || planned.Site != "sre" || planned.FilesPublished != 5 || planned.FilesRemoved != 1 || !reflect.DeepEqual(planned.Changes, wantChanges) {
		t.Fatalf("site sync dry-run result = %+v, want planned creates %+v", planned, wantChanges)
	}
	wantPreviewChanges := []struct {
		Action  string `json:"action"`
		GroupID string `json:"groupId"`
		HeadSHA string `json:"headSha"`
		Reason  string `json:"reason"`
	}{{Action: "remove", GroupID: "pr:42", HeadSHA: staleHeadSHA, Reason: "manifest-missing"}}
	if !reflect.DeepEqual(planned.PreviewChanges, wantPreviewChanges) {
		t.Fatalf("site sync dry-run previewChanges = %+v, want %+v", planned.PreviewChanges, wantPreviewChanges)
	}
	if afterDryRun := snapshotFiles(t, storageRoot); !reflect.DeepEqual(afterDryRun, beforeDryRun) {
		t.Fatalf("site sync dry-run changed local storage: before=%v after=%v", beforeDryRun, afterDryRun)
	}
	unchangedCatalog, err := os.ReadFile(staleCatalogPath)
	if err != nil || !bytes.Equal(unchangedCatalog, staleCatalog) {
		t.Fatalf("site sync dry-run changed preview catalog: got=%q err=%v, want original bytes", unchangedCatalog, err)
	}

	args = []string{"site", "sync", "--site", "sre", "--source", "docs/artifacts", "--format", "json"}
	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("site sync exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var published publisher.Result
	if err := json.Unmarshal([]byte(stdout), &published); err != nil {
		t.Fatalf("decode site sync JSON: %v; output=%s", err, stdout)
	}
	if published.Operation != "site sync" || published.Outcome != "synced" || published.Site != "sre" || published.FilesPublished != 5 || published.FilesRemoved != 1 || !reflect.DeepEqual(published.Changes, wantChanges) {
		t.Fatalf("site sync result = %+v, want published result with changes %+v", published, wantChanges)
	}
	artifact, err := os.ReadFile(filepath.Join(storageRoot, "_artifacts", "sre", "overview.html"))
	if err != nil || string(artifact) != "<title>Overview</title><h1>Overview</h1>" {
		t.Fatalf("published local artifact = %q, err=%v", artifact, err)
	}
	if _, err := os.Stat(staleArtifactPath); !os.IsNotExist(err) {
		t.Fatalf("stale local artifact remains after publish: stat error = %v", err)
	}

	textDryRunArgs := []string{"site", "sync", "--site", "sre", "--source", "docs/artifacts", "--dry-run"}
	stdout, stderr, exitCode = runCLIProcess(t, root, textDryRunArgs)
	if exitCode != 0 {
		t.Fatalf("site sync text dry-run no-op exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	for _, expected := range []string{
		"site sync sre  DRY RUN",
		"+ 0 create   ~ 0 update   - 0 remove",
		"Dry run complete. No writes.",
	} {
		if !strings.Contains(stdout, expected) {
			t.Errorf("site sync text dry-run no-op output is missing %q:\n%s", expected, stdout)
		}
	}

	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("site sync no-op exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var noOp publisher.Result
	if err := json.Unmarshal([]byte(stdout), &noOp); err != nil {
		t.Fatalf("decode site sync no-op JSON: %v; output=%s", err, stdout)
	}
	if noOp.Operation != "site sync" || noOp.Outcome != "no-op" || noOp.Site != "sre" || noOp.Changes == nil || len(noOp.Changes) != 0 || noOp.PreviewChanges == nil || len(*noOp.PreviewChanges) != 0 {
		t.Fatalf("site sync no-op result = %+v, want an empty machine-readable no-op", noOp)
	}
	assertEmptyPreviewChangesField(t, stdout)
}

func TestPreviewRemoveCLIHelpValidationNoOpAndJSONFailure(t *testing.T) {
	var helpOut, helpErr bytes.Buffer
	if err := run(t.Context(), []string{"preview", "remove", "--help"}, &helpOut, &helpErr); err != nil || !strings.Contains(helpOut.String(), "--site ID --group ID") {
		t.Fatalf("preview remove help = %q, %v; stderr=%q", helpOut.String(), err, helpErr.String())
	}
	for _, args := range [][]string{
		{"preview", "remove", "--site", "sre"},
		{"preview", "remove", "--group", "pr:42"},
		{"preview", "remove", "--site", "sre", "--group", "feature-branch"},
	} {
		var stdout, stderr bytes.Buffer
		err := run(t.Context(), args, &stdout, &stderr)
		if err == nil || commandExitCode(err) != 2 {
			t.Errorf("run(%v) error = %v; want argument validation exit 2", args, err)
		}
	}

	root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	args := []string{"preview", "remove", "--site", "sre", "--group", "pr:42", "--dry-run", "--format", "json"}
	stdout, stderr, exitCode := runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("preview remove no-op CLI exit=%d stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var noOp map[string]any
	if err := json.Unmarshal([]byte(stdout), &noOp); err != nil || noOp["operation"] != "preview remove" || noOp["groupId"] != "pr:42" || noOp["outcome"] != "no-op" {
		t.Fatalf("preview remove no-op JSON = %#v, err=%v; output=%s", noOp, err, stdout)
	}
	lockPath := filepath.Join(root, ".local", "storage", "_control", "locks", "sites", "sre.json")
	if _, err := os.Stat(lockPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("dry-run created site lock %s: %v", lockPath, err)
	}

	legacyCatalogPath := filepath.Join(root, ".local", "storage", "_previews", "sre", "catalog.json")
	if err := os.MkdirAll(filepath.Dir(legacyCatalogPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyCatalogPath, []byte(`{"schemaVersion":1,"site":"sre","groups":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	args = []string{"preview", "remove", "--site", "sre", "--group", "pr:42", "--format", "json"}
	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode == 0 {
		t.Fatalf("legacy preview catalog unexpectedly removed successfully: stdout=%s stderr=%s", stdout, stderr)
	}
	var failure map[string]any
	if err := json.Unmarshal([]byte(stdout), &failure); err != nil || failure["operation"] != "preview remove" || failure["outcome"] != "failed" || failure["groupId"] != "pr:42" || failure["error"] == "" {
		t.Fatalf("preview remove failure JSON = %#v, err=%v; stdout=%s stderr=%s", failure, err, stdout, stderr)
	}
}

func TestRegistrySyncReconcilesOmittedSitesAndRetriesCleanup(t *testing.T) {
	root := createLocalUnregisterCheckout(t)
	storageRoot := filepath.Join(root, ".local", "storage")
	before := snapshotFiles(t, storageRoot)
	args := []string{"registry", "sync", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json"}
	stdout, stderr, exitCode := runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("registry sync dry-run exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var planned publisher.Result
	if err := json.Unmarshal([]byte(stdout), &planned); err != nil {
		t.Fatalf("decode registry sync dry-run JSON: %v; output=%s", err, stdout)
	}
	if planned.Operation != "registry sync" || planned.Outcome != "planned" || planned.RegistryUpdated == nil || *planned.RegistryUpdated {
		t.Fatalf("registry sync dry-run = %+v; want a read-only complete desired-state plan", planned)
	}
	for _, expected := range []string{
		"_artifacts/sre/report.html", "_indexes/sre/index.json", "_previews/sre/catalog.json",
	} {
		if !containsChange(planned.Changes, "remove", expected) {
			t.Errorf("sync plan does not remove omitted site's %q: %+v", expected, planned.Changes)
		}
	}
	if after := snapshotFiles(t, storageRoot); !reflect.DeepEqual(after, before) {
		t.Fatalf("dry-run changed local storage: before=%v after=%v", before, after)
	}

	args = []string{"registry", "sync", "--config", "artifact-pages.yaml", "--format", "json"}
	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("registry sync exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var applied publisher.Result
	if err := json.Unmarshal([]byte(stdout), &applied); err != nil {
		t.Fatalf("decode registry sync JSON: %v; output=%s", err, stdout)
	}
	if applied.Operation != "registry sync" || applied.Outcome != "synced" || applied.RegistryUpdated == nil || !*applied.RegistryUpdated || applied.FilesRemoved != 6 {
		t.Fatalf("registry sync = %+v; want complete projection and six omitted-site objects removed", applied)
	}
	if !reflect.DeepEqual(applied.Changes, planned.Changes) {
		t.Fatalf("registry sync changes = %+v, dry-run changes = %+v", applied.Changes, planned.Changes)
	}
	assertLocalUnregisterResult(t, storageRoot, "sre")

	// Repeating the complete desired-state sync is idempotent.
	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("repeated registry sync exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var repeated publisher.Result
	if err := json.Unmarshal([]byte(stdout), &repeated); err != nil {
		t.Fatalf("decode repeated registry sync JSON: %v; output=%s", err, stdout)
	}
	if repeated.Outcome != "no-op" || repeated.RegistryUpdated == nil || *repeated.RegistryUpdated || repeated.FilesRemoved != 0 {
		t.Fatalf("repeated registry sync = %+v; want an idempotent unchanged projection", repeated)
	}

	t.Run("cleanup failure retries after config has omitted the site", func(t *testing.T) {
		root := createLocalUnregisterCheckout(t)
		storageRoot := filepath.Join(root, ".local", "storage")
		artifactPrefix := filepath.Join(storageRoot, "_artifacts", "sre")
		if err := os.RemoveAll(artifactPrefix); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(artifactPrefix, []byte("block the listing directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		args := []string{"registry", "sync", "--config", "artifact-pages.yaml", "--format", "json"}
		stdout, stderr, exitCode := runCLIProcess(t, root, args)
		if exitCode != 1 {
			t.Fatalf("registry sync cleanup failure exit code = %d, want 1; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var failure struct {
			publisher.Result
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
			t.Fatalf("decode registry sync failure JSON: %v; output=%s", err, stdout)
		}
		if failure.Operation != "registry sync" || failure.Outcome != "failed" || failure.RegistryUpdated == nil || !*failure.RegistryUpdated || !strings.Contains(failure.Error, "list site \"sre\" for cleanup") {
			t.Fatalf("registry sync failure = %+v; want committed projection and retryable cleanup error", failure)
		}
		cleanupRecord, err := os.ReadFile(filepath.Join(storageRoot, "_control", "registry-cleanup.json"))
		if err != nil || !strings.Contains(string(cleanupRecord), "sre") {
			t.Fatalf("cleanup retry record = %q, err=%v; want explicit sre target", cleanupRecord, err)
		}
		if err := os.Remove(artifactPrefix); err != nil {
			t.Fatal(err)
		}
		writeLocalUnregisterObject(t, storageRoot, "_artifacts/sre/report.html", []byte("restored artifact"))
		stdout, stderr, exitCode = runCLIProcess(t, root, args)
		if exitCode != 0 {
			t.Fatalf("registry sync retry exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var retried publisher.Result
		if err := json.Unmarshal([]byte(stdout), &retried); err != nil {
			t.Fatalf("decode registry sync retry JSON: %v; output=%s", err, stdout)
		}
		if retried.Outcome != "synced" || retried.RegistryUpdated == nil || *retried.RegistryUpdated || retried.FilesRemoved != 6 {
			t.Fatalf("registry sync retry = %+v; want completed cleanup without a second registry write", retried)
		}
		if _, err := os.Stat(filepath.Join(storageRoot, "_control", "registry-cleanup.json")); !os.IsNotExist(err) {
			t.Fatalf("registry cleanup record remains after retry: stat err=%v", err)
		}
		assertLocalUnregisterResult(t, storageRoot, "sre")
	})
}

func createLocalUnregisterCheckout(t *testing.T) string {
	t.Helper()
	root := createLocalSitePublishCheckout(t, localRegistryBeforeUnregister)
	if err := os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte(localUnregisterManifest), 0o600); err != nil {
		t.Fatal(err)
	}
	projection := testRegistryBytes(t, localRegistryBeforeUnregister)
	storageRoot := filepath.Join(root, ".local", "storage")
	for key, contents := range map[string][]byte{
		"_indexes/sites.json":                          projection,
		"_artifacts/sre/report.html":                   []byte("SRE artifact"),
		"_indexes/sre/index.json":                      []byte(`{"site":"sre"}`),
		"_indexes/sre/meta.json":                       []byte(`{"site":"sre"}`),
		"_previews/sre/catalog.json":                   []byte(`{"site":"sre"}`),
		"_previews/sre/revisions/head/manifest.json":   []byte(`{"site":"sre"}`),
		"_previews/sre/revisions/head/files/report.md": []byte("preview document"),
		"_artifacts/docs/neighbor.html":                []byte("neighbor artifact"),
		"_indexes/docs/index.json":                     []byte(`{"site":"docs"}`),
		"_indexes/docs/meta.json":                      []byte(`{"site":"docs"}`),
		"_previews/docs/catalog.json":                  []byte(`{"site":"docs"}`),
		"index.html":                                   []byte("application shell"),
		"assets/app.js":                                []byte("application asset"),
		"_control/private/sentinel":                    []byte("private control object"),
	} {
		writeLocalUnregisterObject(t, storageRoot, key, contents)
	}
	for _, siteID := range []string{"sre", "docs", "registry"} {
		lockJSON := []byte(`{"schemaVersion":1,"site":"` + siteID + `","state":"free"}`)
		key := "_control/sites/" + siteID + "/lock.json"
		if siteID == "registry" {
			key = "_control/locks/registry.json"
		}
		writeLocalUnregisterObject(t, storageRoot, key, lockJSON)
	}
	return root
}

func writeLocalUnregisterObject(t *testing.T, storageRoot, key string, contents []byte) {
	t.Helper()
	objectPath := filepath.Join(storageRoot, filepath.FromSlash(key))
	if err := os.MkdirAll(filepath.Dir(objectPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(objectPath, contents, 0o600); err != nil {
		t.Fatal(err)
	}
}

func assertLocalUnregisterResult(t *testing.T, storageRoot, siteID string) {
	t.Helper()
	for _, prefix := range []string{"_artifacts/" + siteID, "_indexes/" + siteID, "_previews/" + siteID} {
		if _, err := os.Stat(filepath.Join(storageRoot, filepath.FromSlash(prefix))); !os.IsNotExist(err) {
			t.Errorf("unregistered site prefix %q remains: stat err=%v", prefix, err)
		}
	}
	for key, want := range map[string]string{
		"_artifacts/docs/neighbor.html": "neighbor artifact",
		"_indexes/docs/meta.json":       `{"site":"docs"}`,
		"_previews/docs/catalog.json":   `{"site":"docs"}`,
		"index.html":                    "application shell",
		"assets/app.js":                 "application asset",
		"_control/private/sentinel":     "private control object",
	} {
		contents, err := os.ReadFile(filepath.Join(storageRoot, filepath.FromSlash(key)))
		if err != nil || string(contents) != want {
			t.Errorf("unrelated object %q = %q, err=%v; want %q", key, contents, err, want)
		}
	}
	for _, key := range []string{"_control/sites/sre/lock.json", "_control/sites/docs/lock.json", "_control/locks/registry.json"} {
		if _, err := os.Stat(filepath.Join(storageRoot, filepath.FromSlash(key))); err != nil {
			t.Errorf("control lock %q was removed: %v", key, err)
		}
	}
}

func containsChange(changes []publisher.Change, action, path string) bool {
	for _, change := range changes {
		if change.Action == action && change.Path == path {
			return true
		}
	}
	return false
}

func TestSitePublishFailureJSONAndExitCodes(t *testing.T) {
	t.Run("malformed config", func(t *testing.T) {
		root := t.TempDir()
		const credential = "do-not-print-this-credential"
		config := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n  apiToken: " + credential + "\n"
		if err := os.WriteFile(filepath.Join(root, "deployment.yaml"), []byte(config), 0o600); err != nil {
			t.Fatal(err)
		}

		stdout, stderr, exitCode := runCLIProcess(t, root, []string{"site", "sync", "--site", "sre", "--config", "deployment.yaml", "--format", "json"})
		if exitCode != 2 {
			t.Fatalf("site sync malformed-config exit code = %d, want 2; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var failure struct {
			Operation string             `json:"operation"`
			Outcome   string             `json:"outcome"`
			Site      string             `json:"site"`
			Changes   []publisher.Change `json:"changes"`
			Error     string             `json:"error"`
		}
		if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
			t.Fatalf("decode malformed-config failure JSON: %v; output=%s; stderr=%s", err, stdout, stderr)
		}
		if failure.Operation != "site sync" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Changes == nil || !strings.Contains(failure.Error, "apiToken") {
			t.Fatalf("malformed-config failure result = %+v, want stable failure envelope", failure)
		}
		assertEmptyPreviewChangesField(t, stdout)
		if strings.Contains(stdout+stderr, credential) {
			t.Fatalf("failure output exposed config credential: stdout=%s stderr=%s", stdout, stderr)
		}
		if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
			t.Fatalf("local backend was created after config failure: stat error = %v", err)
		}
	})

	t.Run("unregistered site", func(t *testing.T) {
		const unrelatedSiteManifest = "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\nsites:\n  frontend:\n    name: Frontend\n    repository: acme/frontend\n    sourcePath: docs/artifacts\n"
		root := createLocalSitePublishCheckout(t, unrelatedSiteManifest)
		stdout, stderr, exitCode := runCLIProcess(t, root, []string{"site", "sync", "--site", "sre", "--source", "docs/artifacts", "--config", "artifact-pages.yaml", "--format", "json"})
		if exitCode != 1 {
			t.Fatalf("site sync unregistered-site exit code = %d, want 1; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var failure struct {
			Operation string             `json:"operation"`
			Outcome   string             `json:"outcome"`
			Site      string             `json:"site"`
			Changes   []publisher.Change `json:"changes"`
			Error     string             `json:"error"`
		}
		if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
			t.Fatalf("decode unregistered-site failure JSON: %v; output=%s; stderr=%s", err, stdout, stderr)
		}
		if failure.Operation != "site sync" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Changes == nil || !strings.Contains(failure.Error, "is not registered") {
			t.Fatalf("unregistered-site failure result = %+v, want stable failure envelope", failure)
		}
		assertEmptyPreviewChangesField(t, stdout)
		textArgs := []string{"site", "sync", "--site", "sre", "--dry-run"}
		textOut, textErr, textExit := runCLIProcess(t, root, textArgs)
		if textExit != 1 || textOut != "" || !strings.Contains(textErr, "site sync sre  DRY RUN FAILED") || !strings.Contains(textErr, "Registered sites: frontend") || strings.Contains(textErr, "\x1b") {
			t.Fatalf("unregistered text report: exit=%d stdout=%q stderr=%q", textExit, textOut, textErr)
		}
		for _, key := range []string{
			filepath.Join(root, ".local", "storage", "_artifacts", "sre", "overview.html"),
			filepath.Join(root, ".local", "storage", "_indexes", "sre", "index.json"),
			filepath.Join(root, ".local", "storage", "_indexes", "sre", "meta.json"),
		} {
			if _, err := os.Stat(key); !os.IsNotExist(err) {
				t.Errorf("unregistered publish created site object %s: stat error = %v", key, err)
			}
		}
	})

	t.Run("local provider read failure", func(t *testing.T) {
		root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
		storageRoot := filepath.Join(root, ".local", "storage")
		registryPath := filepath.Join(storageRoot, "_indexes", "sites.json")
		if err := os.Remove(registryPath); err != nil {
			t.Fatal(err)
		}
		// A directory at the object key makes the local provider return a
		// deterministic read error instead of treating it as a missing object.
		if err := os.Mkdir(registryPath, 0o755); err != nil {
			t.Fatal(err)
		}

		stdout, stderr, exitCode := runCLIProcess(t, root, []string{"site", "sync", "--site", "sre", "--source", "docs/artifacts", "--format", "json"})
		if exitCode != 1 {
			t.Fatalf("site sync provider-read exit code = %d, want 1; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var failure struct {
			Operation      string             `json:"operation"`
			Outcome        string             `json:"outcome"`
			Site           string             `json:"site"`
			Changes        []publisher.Change `json:"changes"`
			PreviewChanges []json.RawMessage  `json:"previewChanges"`
			Error          string             `json:"error"`
		}
		if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
			t.Fatalf("decode provider-read failure JSON: %v; output=%s; stderr=%s", err, stdout, stderr)
		}
		if failure.Operation != "site sync" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Changes == nil || failure.PreviewChanges == nil || !strings.Contains(failure.Error, "read deployed site registry") {
			t.Fatalf("provider-read failure result = %+v, want stable site-publish failure envelope", failure)
		}
		assertEmptyPreviewChangesField(t, stdout)
	})
}

func assertEmptyPreviewChangesField(t *testing.T, output string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(output), &fields); err != nil {
		t.Fatalf("decode site sync JSON fields: %v; output=%s", err, output)
	}
	previewChanges, exists := fields["previewChanges"]
	if !exists || string(previewChanges) != "[]" {
		t.Fatalf("site sync previewChanges JSON = %q (present=%t), want []", previewChanges, exists)
	}
}

func TestCLIProcessHelper(t *testing.T) {
	if os.Getenv(cliProcessHelperEnv) != "1" {
		return
	}
	var args []string
	if err := json.Unmarshal([]byte(os.Getenv(cliProcessArgsEnv)), &args); err != nil {
		fmt.Fprintln(os.Stderr, "decode CLI helper arguments:", err)
		os.Exit(98)
	}
	os.Args = append([]string{os.Args[0]}, args...)
	main()
	os.Exit(0)
}

func TestDeploymentResultReportsResolvedRemoteConfigCommit(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	resolved := deploymentconfig.ResolvedConfig{
		CommitSHA: sha,
		Config: deploymentconfig.DeploymentConfig{
			Provider: "aws",
			AWS:      &deploymentconfig.AWSTarget{AccountID: "123456789012", Region: "us-east-1", Bucket: "artifact-pages-123456789012-us-east-1"},
		},
	}
	result := publisher.Result{Operation: "site sync", Outcome: "planned", Changes: []publisher.Change{}}

	var jsonOutput bytes.Buffer
	if err := encodeDeploymentResult(&jsonOutput, result, resolved); err != nil {
		t.Fatalf("encodeDeploymentResult() error = %v", err)
	}
	var encoded map[string]any
	if err := json.Unmarshal(jsonOutput.Bytes(), &encoded); err != nil {
		t.Fatalf("decode JSON result: %v", err)
	}
	target, ok := encoded["target"].(map[string]any)
	if !ok || target["provider"] != "aws" || target["bucket"] != "artifact-pages-123456789012-us-east-1" || target["region"] != "us-east-1" || target["accountId"] != "123456789012" {
		t.Fatalf("JSON target = %v, want effective AWS target", encoded["target"])
	}
	if encoded["configCommitSha"] != sha || encoded["operation"] != "site sync" {
		t.Fatalf("JSON result = %v, want operation, target, and resolved config SHA", encoded)
	}
	if _, nested := encoded["Result"]; nested {
		t.Fatalf("JSON result unexpectedly nests operation fields: %v", encoded)
	}

	var textOutput bytes.Buffer
	reportTarget(&textOutput, resolved)
	wantText := "  Target    AWS S3 bucket artifact-pages-123456789012-us-east-1 (region us-east-1, account 123456789012)\n  Config    " + sha + "\n"
	if textOutput.String() != wantText {
		t.Fatalf("text deployment report = %q, want %q", textOutput.String(), wantText)
	}
}

func TestDeploymentResultReportsCloudflareDefaultsWithoutCredentialNames(t *testing.T) {
	config, err := deploymentconfig.Parse([]byte(`schemaVersion: 1
provider: cloudflare
cloudflare:
  accountId: 0123456789abcdef0123456789abcdef
  zoneId: abcdef0123456789abcdef0123456789
  publicBaseURL: https://pages.example.test
`))
	if err != nil {
		t.Fatalf("Parse(minimal Cloudflare config): %v", err)
	}
	resolved := deploymentconfig.ResolvedConfig{Config: config}
	var output bytes.Buffer
	if err := encodeDeploymentResult(&output, publisher.Result{Operation: "registry sync", Outcome: "planned", Changes: []publisher.Change{}}, resolved); err != nil {
		t.Fatalf("encodeDeploymentResult(): %v", err)
	}
	var encoded map[string]any
	if err := json.Unmarshal(output.Bytes(), &encoded); err != nil {
		t.Fatalf("decode JSON result: %v; output=%s", err, output.String())
	}
	target, ok := encoded["target"].(map[string]any)
	if !ok || target["provider"] != "cloudflare" || target["bucket"] != "artifact-pages" || target["accountId"] != "0123456789abcdef0123456789abcdef" {
		t.Fatalf("JSON target = %v, want resolved Cloudflare target", encoded["target"])
	}
	if strings.Contains(output.String(), "CF_R2_ACCESS_KEY_ID") || strings.Contains(output.String(), "CF_API_TOKEN") {
		t.Fatalf("JSON output included credential environment names: %s", output.String())
	}
	var text bytes.Buffer
	reportTarget(&text, resolved)
	if !strings.Contains(text.String(), "Cloudflare R2 bucket artifact-pages") {
		t.Fatalf("text deployment output = %q, want effective default bucket", text.String())
	}
}

func TestSitePublishRejectsMalformedConfigBeforeCreatingLocalBackend(t *testing.T) {
	root := t.TempDir()
	previousDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previousDirectory) })

	const credential = "do-not-print-this-credential"
	configPath := filepath.Join(root, "deployment.yaml")
	contents := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n  apiToken: " + credential + "\n"
	if err := os.WriteFile(configPath, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	err = run(t.Context(), []string{"site", "sync", "--site", "sre", "--source", "docs", "--config", configPath}, &stdout, &stderr)
	if err == nil {
		t.Fatal("run(site sync) succeeded with malformed config")
	}
	if strings.Contains(err.Error(), credential) {
		t.Fatalf("config error exposed credential value: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
		t.Fatalf("local backend was created after config failure: stat error = %v", err)
	}
}

func TestRunAppDeployReportsNoOpForUnchangedBundleAndPreservesSiteContent(t *testing.T) {
	root := t.TempDir()
	storageRoot := filepath.Join(root, "storage")
	configPath := filepath.Join(root, "deployment.yaml")
	configContents := fmt.Sprintf("schemaVersion: 1\nprovider: local\nlocal:\n  root: %q\n", storageRoot)
	if err := os.WriteFile(configPath, []byte(configContents), 0o600); err != nil {
		t.Fatal(err)
	}
	archivePath := createAppBundleForTest(t, filepath.Join(root, "artifact-pages-web-vtest-1.tar.gz"), "test-1", map[string][]byte{
		"index.html":             []byte("<script src=\"/assets/app-AbC123xY.js\"></script><script src=\"/assets/app.js\"></script>"),
		"assets/app-AbC123xY.js": []byte("console.log('hashed ready')"),
		"assets/app.js":          []byte("console.log('fixed ready')"),
	})
	backend, err := publisher.NewDirectoryBackend(storageRoot)
	if err != nil {
		t.Fatal(err)
	}
	contentBefore := map[string][]byte{
		"_indexes/sites.json":        []byte(`{"sites":[{"id":"sre"}]}`),
		"_indexes/sre/index.json":    []byte(`{"site":"sre"}`),
		"_artifacts/sre/report.html": []byte("<h1>site content</h1>"),
		"_previews/sre/catalog.json": []byte(`{"site":"sre"}`),
	}
	for key, contents := range contentBefore {
		if err := backend.PutObject(t.Context(), key, publisher.Object{Bytes: contents}); err != nil {
			t.Fatalf("seed site content %s: %v", key, err)
		}
	}

	args := []string{"app", "deploy", "--archive", archivePath, "--config", configPath, "--format", "json"}
	var stdout, stderr bytes.Buffer
	beforeDryRun := snapshotFiles(t, storageRoot)
	dryRunArgs := append(append([]string(nil), args...), "--dry-run")
	if err := run(t.Context(), dryRunArgs, &stdout, &stderr); err != nil {
		t.Fatalf("app deploy dry-run error = %v; stderr=%s", err, stderr.String())
	}
	var planned publisher.Result
	if err := json.Unmarshal(stdout.Bytes(), &planned); err != nil {
		t.Fatalf("decode app deploy dry-run JSON: %v; output=%s", err, stdout.String())
	}
	wantPlan := []publisher.Change{
		{Action: "create", Path: "assets/app-AbC123xY.js"},
		{Action: "create", Path: "assets/app.js"},
		{Action: "create", Path: "index.html"},
	}
	if planned.Operation != "app deploy" || planned.Outcome != "planned" || planned.FilesPublished != 3 || !reflect.DeepEqual(planned.Changes, wantPlan) {
		t.Fatalf("app deploy dry-run = %+v, want read-only plan %+v", planned, wantPlan)
	}
	if afterDryRun := snapshotFiles(t, storageRoot); !reflect.DeepEqual(afterDryRun, beforeDryRun) {
		t.Fatalf("app deploy dry-run changed local storage: before=%v after=%v", beforeDryRun, afterDryRun)
	}
	stdout.Reset()
	stderr.Reset()
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("first app deploy error = %v; stderr=%s", err, stderr.String())
	}
	var first publisher.Result
	if err := json.Unmarshal(stdout.Bytes(), &first); err != nil {
		t.Fatalf("decode first app deploy JSON: %v; output=%s", err, stdout.String())
	}
	if first.Operation != "app deploy" || first.Outcome != "deployed" || first.FilesPublished != 3 {
		t.Fatalf("first app deploy = %+v, want three-file deployment", first)
	}

	stdout.Reset()
	stderr.Reset()
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("unchanged app deploy error = %v; stderr=%s", err, stderr.String())
	}
	var unchanged publisher.Result
	if err := json.Unmarshal(stdout.Bytes(), &unchanged); err != nil {
		t.Fatalf("decode unchanged app deploy JSON: %v; output=%s", err, stdout.String())
	}
	if unchanged.Operation != "app deploy" || unchanged.Outcome != "no-op" || unchanged.Version != first.Version || unchanged.FilesPublished != 0 || unchanged.Changes == nil || len(unchanged.Changes) != 0 {
		t.Fatalf("unchanged app deploy = %+v, want explicit no-op result", unchanged)
	}

	stdout.Reset()
	stderr.Reset()
	textArgs := []string{"app", "deploy", "--archive", archivePath, "--config", configPath}
	if err := run(t.Context(), textArgs, &stdout, &stderr); err != nil {
		t.Fatalf("unchanged app deploy text output error = %v; stderr=%s", err, stderr.String())
	}
	if !strings.Contains(stdout.String(), "app deploy test-1  UP TO DATE") {
		t.Errorf("unchanged app deploy text output = %q, want no-op message", stdout.String())
	}

	for key, want := range contentBefore {
		object, _, err := backend.GetObject(t.Context(), key)
		if err != nil || !bytes.Equal(object.Bytes, want) {
			t.Errorf("site content %s changed during app deploy: got=%q want=%q err=%v", key, object.Bytes, want, err)
		}
	}
	appShell, _, err := backend.GetObject(t.Context(), "index.html")
	if err != nil || !bytes.Contains(appShell.Bytes, []byte("app-AbC123xY.js")) {
		t.Errorf("deployed app shell = %q, err=%v", appShell.Bytes, err)
	}
}

func createAppBundleForTest(t *testing.T, archivePath, version string, files map[string][]byte) string {
	t.Helper()
	archiveFile, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(archiveFile)
	tarWriter := tar.NewWriter(gzipWriter)
	paths := make([]string, 0, len(files))
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	for _, path := range paths {
		contents := files[path]
		if err := tarWriter.WriteHeader(&tar.Header{Name: "./" + path, Mode: 0o644, Size: int64(len(contents)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}
	archiveContents, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	digestBytes := sha256.Sum256(archiveContents)
	digest := hex.EncodeToString(digestBytes[:])
	manifest := struct {
		SchemaVersion int      `json:"schemaVersion"`
		Product       string   `json:"product"`
		Component     string   `json:"component"`
		Version       string   `json:"version"`
		Archive       string   `json:"archive"`
		ArchiveSHA256 string   `json:"archiveSha256"`
		SourceCommit  string   `json:"sourceCommit"`
		SourceDirty   bool     `json:"sourceDirty"`
		Files         []string `json:"files"`
	}{
		SchemaVersion: 1, Product: "artifact-pages", Component: "web", Version: version,
		Archive: filepath.Base(archivePath), ArchiveSHA256: digest,
		SourceCommit: strings.Repeat("a", 40), Files: paths,
	}
	manifestContents, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath+".json", manifestContents, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath+".sha256", []byte(fmt.Sprintf("%s  %s\n", digest, filepath.Base(archivePath))), 0o600); err != nil {
		t.Fatal(err)
	}
	return archivePath
}

func TestLockCLIInspectsAndRecoversUsingObservedETag(t *testing.T) {
	root := t.TempDir()
	storageRoot := filepath.Join(root, "storage")
	backend, err := publisher.NewDirectoryBackend(storageRoot)
	if err != nil {
		t.Fatal(err)
	}
	manager := publisher.SiteLockManager{Backend: backend}
	held, _, err := manager.Acquire(t.Context(), "sre")
	if err != nil {
		t.Fatalf("prepare held lock: %v", err)
	}
	configPath := filepath.Join(root, "deployment.yaml")
	configContents := fmt.Sprintf("schemaVersion: 1\nprovider: local\nlocal:\n  root: %q\n", storageRoot)
	if err := os.WriteFile(configPath, []byte(configContents), 0o600); err != nil {
		t.Fatal(err)
	}

	type cliResult struct {
		Operation string                 `json:"operation"`
		Outcome   string                 `json:"outcome"`
		Lock      publisher.LockSnapshot `json:"lock"`
	}
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"lock", "inspect", "--site", "sre", "--config", configPath, "--format", "json"}, &stdout, &stderr); err != nil {
		t.Fatalf("lock inspect error = %v; stderr=%s", err, stderr.String())
	}
	var inspected cliResult
	if err := json.Unmarshal(stdout.Bytes(), &inspected); err != nil {
		t.Fatalf("decode lock inspect JSON: %v; output=%s", err, stdout.String())
	}
	if inspected.Operation != "lock inspect" || inspected.Outcome != "inspected" || inspected.Lock.State != "held" || inspected.Lock.ETag != held.ETag {
		t.Fatalf("lock inspect result = %+v, want observed held lock", inspected)
	}

	stdout.Reset()
	stderr.Reset()
	args := []string{"lock", "recover", "--site", "sre", "--observed-etag", inspected.Lock.ETag, "--config", configPath, "--format", "json"}
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("lock recover error = %v; stderr=%s", err, stderr.String())
	}
	var recovered cliResult
	if err := json.Unmarshal(stdout.Bytes(), &recovered); err != nil {
		t.Fatalf("decode lock recover JSON: %v; output=%s", err, stdout.String())
	}
	if recovered.Operation != "lock recover" || recovered.Outcome != "recovered" || recovered.Lock.State != "free" || recovered.Lock.ETag == inspected.Lock.ETag {
		t.Fatalf("lock recover result = %+v, want recovered free lock with new ETag", recovered)
	}
}

func TestLockCLIInspectsAndRecoversApplicationScope(t *testing.T) {
	root := t.TempDir()
	storageRoot := filepath.Join(root, "storage")
	backend, err := publisher.NewDirectoryBackend(storageRoot)
	if err != nil {
		t.Fatal(err)
	}
	manager := publisher.SiteLockManager{Backend: backend}
	held, _, err := manager.AcquireApplication(t.Context())
	if err != nil {
		t.Fatalf("prepare held application lock: %v", err)
	}
	configPath := filepath.Join(root, "deployment.yaml")
	configContents := fmt.Sprintf("schemaVersion: 1\nprovider: local\nlocal:\n  root: %q\n", storageRoot)
	if err := os.WriteFile(configPath, []byte(configContents), 0o600); err != nil {
		t.Fatal(err)
	}
	type cliResult struct {
		Operation string                 `json:"operation"`
		Outcome   string                 `json:"outcome"`
		Site      string                 `json:"site"`
		Lock      publisher.LockSnapshot `json:"lock"`
	}
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"lock", "inspect", "--scope", "application", "--config", configPath, "--format", "json"}, &stdout, &stderr); err != nil {
		t.Fatalf("application lock inspect error = %v; stderr=%s", err, stderr.String())
	}
	var inspected cliResult
	if err := json.Unmarshal(stdout.Bytes(), &inspected); err != nil {
		t.Fatalf("decode application lock inspect: %v; output=%s", err, stdout.String())
	}
	if inspected.Operation != "lock inspect" || inspected.Site != "application" || inspected.Lock.Site != "application" || inspected.Lock.State != "held" || inspected.Lock.ETag != held.ETag {
		t.Fatalf("application lock inspect result = %+v; want held application scope", inspected)
	}

	stdout.Reset()
	stderr.Reset()
	args := []string{"lock", "recover", "--scope", "application", "--observed-etag", inspected.Lock.ETag, "--config", configPath, "--format", "json"}
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("application lock recover error = %v; stderr=%s", err, stderr.String())
	}
	var recovered cliResult
	if err := json.Unmarshal(stdout.Bytes(), &recovered); err != nil {
		t.Fatalf("decode application lock recover: %v; output=%s", err, stdout.String())
	}
	if recovered.Operation != "lock recover" || recovered.Site != "application" || recovered.Lock.Site != "application" || recovered.Outcome != "recovered" || recovered.Lock.State != "free" {
		t.Fatalf("application lock recover result = %+v; want recovered free lock", recovered)
	}

	stdout.Reset()
	stderr.Reset()
	if err := run(t.Context(), []string{"lock", "inspect", "--scope", "application", "--site", "sre", "--config", configPath}, &stdout, &stderr); err == nil {
		t.Fatal("application lock scope accepted --site; want input error")
	}
}

func runGitCommand(workingDirectory string, args ...string) error {
	command := exec.Command("git", args...)
	command.Dir = workingDirectory
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("git %v: %w: %s", args, err, output)
	}
	return nil
}

const registeredLocalSiteManifest = "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\nsites:\n  sre:\n    name: SRE & Platform\n    repository: acme/sre\n    sourcePath: docs/artifacts\n"

func createLocalSitePublishCheckout(t *testing.T, siteManifest string) string {
	t.Helper()
	root := t.TempDir()
	previousDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previousDirectory) })

	for _, args := range [][]string{
		{"init"},
		{"config", "user.name", "Artifact Pages Test"},
		{"config", "user.email", "test@example.invalid"},
		{"remote", "add", "origin", "git@github.com:acme/sre.git"},
	} {
		if err := runGitCommand(root, args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "docs", "artifacts"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "overview.html"), []byte("<title>Overview</title><h1>Overview</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte(siteManifest), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "add", "docs/artifacts/overview.html", "artifact-pages.yaml"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "commit", "-m", "add artifact"); err != nil {
		t.Fatal(err)
	}

	projection := testRegistryBytes(t, siteManifest)
	registryPath := filepath.Join(root, ".local", "storage", "_indexes", "sites.json")
	if err := os.MkdirAll(filepath.Dir(registryPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(registryPath, projection, 0o600); err != nil {
		t.Fatal(err)
	}
	return root
}

func testRegistryBytes(t *testing.T, selectedConfig string) []byte {
	t.Helper()
	parsed, err := deploymentconfig.Parse([]byte(selectedConfig))
	if err != nil {
		t.Fatalf("parse unified config fixture: %v", err)
	}
	projection, err := registry.ProjectSites(parsed.Sites)
	if err != nil {
		t.Fatalf("project unified config fixture: %v", err)
	}
	contents, err := registry.Encode(projection)
	if err != nil {
		t.Fatalf("encode unified config fixture: %v", err)
	}
	return contents
}

func snapshotFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := make(map[string][]byte)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = contents
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot files under %s: %v", root, err)
	}
	return files
}

func runCLIProcess(t *testing.T, workingDirectory string, args []string) (stdout, stderr string, exitCode int) {
	t.Helper()
	serializedArgs, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(executable, "-test.run=^TestCLIProcessHelper$")
	command.Dir = workingDirectory
	command.Env = envWithout(os.Environ(), cliProcessHelperEnv, cliProcessArgsEnv)
	command.Env = append(command.Env,
		cliProcessHelperEnv+"=1",
		cliProcessArgsEnv+"="+string(serializedArgs),
	)
	var stdoutBuffer, stderrBuffer bytes.Buffer
	command.Stdout = &stdoutBuffer
	command.Stderr = &stderrBuffer
	err = command.Run()
	if err == nil {
		return stdoutBuffer.String(), stderrBuffer.String(), 0
	}
	var exitError *exec.ExitError
	if !errors.As(err, &exitError) {
		t.Fatalf("run CLI subprocess: %v; stdout=%s stderr=%s", err, stdoutBuffer.String(), stderrBuffer.String())
	}
	return stdoutBuffer.String(), stderrBuffer.String(), exitError.ExitCode()
}

func envWithout(environment []string, names ...string) []string {
	filtered := make([]string, 0, len(environment))
	for _, variable := range environment {
		keep := true
		for _, name := range names {
			if strings.HasPrefix(variable, name+"=") {
				keep = false
				break
			}
		}
		if keep {
			filtered = append(filtered, variable)
		}
	}
	return filtered
}

func TestRunVersionPrintsProductVersionAndRevision(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"version"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(version) error = %v", err)
	}
	if !strings.HasPrefix(stdout.String(), "artifact-pages "+version.Product+"\n") || !strings.Contains(stdout.String(), "Revision") || !strings.Contains(stdout.String(), "  Go        "+runtime.Version()+"\n") {
		t.Fatalf("text version output = %q", stdout.String())
	}
	stdout.Reset()
	if err := run(t.Context(), []string{"version", "--format", "json"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(version --format json) error = %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(stdout.Bytes(), &decoded); err != nil {
		t.Fatalf("json output %q: %v", stdout.String(), err)
	}
	if decoded["operation"] != "version" || decoded["version"] != version.Product {
		t.Fatalf("json version output = %v", decoded)
	}
	if decoded["goVersion"] != runtime.Version() {
		t.Fatalf("json output goVersion = %v, want %s", decoded["goVersion"], runtime.Version())
	}
	if _, ok := decoded["modified"].(bool); !ok {
		t.Fatalf("json output lacks boolean modified: %v", decoded)
	}
}

func TestRunVersionRejectsBadInput(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"version", "--format", "yaml"}, &stdout, &stderr); commandExitCode(err) != 2 {
		t.Fatalf("bad format error = %v, want exit 2", err)
	}
	if err := run(t.Context(), []string{"version", "extra"}, &stdout, &stderr); commandExitCode(err) != 2 {
		t.Fatalf("extra argument error = %v, want exit 2", err)
	}
}

func TestAppDeployNoLongerAcceptsVersionFlag(t *testing.T) {
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"app", "deploy", "--version", "1.2.3"}, &stdout, &stderr)
	if commandExitCode(err) != 2 {
		t.Fatalf("--version error = %v, want exit 2", err)
	}
	if pinnedVersion("") != version.Product || pinnedVersion("x.tar.gz") != "" {
		t.Fatalf("pinnedVersion() does not follow the CLI constant")
	}
}

func TestFullTextFlagIsRemoved(t *testing.T) {
	for _, args := range [][]string{
		{"site", "sync", "--site", "sre", "--source", "docs/artifacts", "--fulltext"},
		{"index", "build", "--site", "sre", "--source", "docs/artifacts", "--fulltext"},
	} {
		var stdout, stderr bytes.Buffer
		err := run(t.Context(), args, &stdout, &stderr)
		if err == nil || commandExitCode(err) != 2 {
			t.Fatalf("%v: err = %v, want exit code 2 for unknown flag", args, err)
		}
	}
}

func TestConfigSetDefaultHelpAndFlagLikeLocatorWriteNothing(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("HOME", configHome)
	t.Setenv("XDG_CONFIG_HOME", configHome)
	t.Setenv("AppData", configHome)
	workingDirectory := t.TempDir()
	t.Chdir(workingDirectory)

	for _, flagArg := range []string{"--help", "-h"} {
		var stdout, stderr bytes.Buffer
		if err := run(t.Context(), []string{"config", "set-default", flagArg}, &stdout, &stderr); err != nil {
			t.Fatalf("run(config set-default %s) error = %v, want nil", flagArg, err)
		}
		if !strings.Contains(stdout.String(), "config set-default LOCATOR") {
			t.Errorf("config set-default %s did not print usage:\n%s", flagArg, stdout.String())
		}
	}
	for _, flagArg := range []string{"--dry-run", "-x", "--config=foo"} {
		var stdout, stderr bytes.Buffer
		err := run(t.Context(), []string{"config", "set-default", flagArg}, &stdout, &stderr)
		var coded *commandError
		if err == nil || !errors.As(err, &coded) || coded.exitCode != 2 {
			t.Fatalf("run(config set-default %s) error = %v, want exit code 2", flagArg, err)
		}
	}
	var written []string
	_ = filepath.WalkDir(configHome, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			written = append(written, path)
		}
		return nil
	})
	if len(written) != 0 {
		t.Errorf("config set-default wrote files %v, want none", written)
	}
}
