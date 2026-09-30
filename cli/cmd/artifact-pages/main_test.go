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
	"sort"
	"strings"
	"testing"

	deploymentconfig "github.com/tasuku43/git-artifact-pages/cli/internal/config"
	previewrecords "github.com/tasuku43/git-artifact-pages/cli/internal/preview"
	"github.com/tasuku43/git-artifact-pages/cli/internal/publisher"
	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
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

func TestRunRootHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(--help) error = %v", err)
	}
	help := stdout.String()
	if !strings.Contains(help, "artifact-pages <command>") {
		t.Errorf("root help does not show the standalone CLI usage:\n%s", stdout.String())
	}
	for _, expected := range []string{"registry register", "registry unregister", "site publish", "app deploy", "lock inspect|recover"} {
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
	if err := run(t.Context(), []string{"registry", "register", "--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(registry register --help) error = %v", err)
	}
	help := stdout.String() + stderr.String()
	for _, expected := range []string{
		"artifact-pages registry register",
		"Reconcile the sites mapping in the selected config",
		"sites omitted from it are unregistered and cleaned on apply",
	} {
		if !strings.Contains(help, expected) {
			t.Errorf("registry register help is missing %q:\n%s", expected, help)
		}
	}
	if strings.Contains(help, "registry publish") || strings.Contains(help, "publish that projection") {
		t.Errorf("registry register help still describes registration as publication:\n%s", help)
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
	args := []string{"registry", "register", "--config", "deployment.yaml", "--format", "json"}
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), append(args, "--dry-run"), &stdout, &stderr); err != nil {
		t.Fatalf("registry register dry-run error = %v; stderr=%s", err, stderr.String())
	}
	var planned struct {
		Operation       string             `json:"operation"`
		Outcome         string             `json:"outcome"`
		Changes         []publisher.Change `json:"changes"`
		RegistryUpdated *bool              `json:"registryUpdated"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &planned); err != nil {
		t.Fatalf("decode registry register dry-run JSON: %v; output=%s", err, stdout.String())
	}
	if planned.Operation != "registry register" || planned.Outcome != "planned" || planned.RegistryUpdated == nil || *planned.RegistryUpdated {
		t.Fatalf("registry register dry-run result = %+v, want a plan with registryUpdated=false", planned)
	}
	wantChanges := []publisher.Change{
		{Action: "invalidate", Path: "/_indexes/sites.json"},
		{Action: "create", Path: "_indexes/sites.json"},
		{Action: "create", Path: "_indexes/sites.json#sites/sre"},
	}
	if !reflect.DeepEqual(planned.Changes, wantChanges) {
		t.Fatalf("registry register dry-run changes = %+v, want %+v", planned.Changes, wantChanges)
	}
	if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
		t.Fatalf("dry-run created local storage: stat error = %v", err)
	}

	stdout.Reset()
	stderr.Reset()
	if err := run(t.Context(), args, &stdout, &stderr); err != nil {
		t.Fatalf("registry register error = %v; stderr=%s", err, stderr.String())
	}
	var applied struct {
		Operation       string `json:"operation"`
		Outcome         string `json:"outcome"`
		RegistryUpdated *bool  `json:"registryUpdated"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &applied); err != nil {
		t.Fatalf("decode registry register JSON: %v; output=%s", err, stdout.String())
	}
	if applied.Operation != "registry register" || applied.Outcome != "registered" || applied.RegistryUpdated == nil || !*applied.RegistryUpdated {
		t.Fatalf("registry register result = %+v, want registered and registryUpdated=true", applied)
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
		{"registry", "register", "--config", "deployment.yaml", "--format", "json"},
		{"registry", "unregister", "--site", "sre", "--config", "deployment.yaml", "--format", "json"},
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
	stdout, stderr, exitCode := runCLIProcess(t, root, []string{"registry", "register", "--config", "deployment.yaml", "--dry-run", "--format", "json"})
	var emptyResult publisher.Result
	if err := json.Unmarshal([]byte(stdout), &emptyResult); err != nil {
		t.Fatalf("decode empty-sites dry-run: %v; stdout=%s", err, stdout)
	}
	if exitCode != 0 || emptyResult.Outcome != "planned" {
		t.Fatalf("registry register with explicit empty sites = exit %d; stdout=%s stderr=%s, want a valid dry-run", exitCode, stdout, stderr)
	}
}

func TestRunRegistryRegisterAcceptsOrderedConfigLayers(t *testing.T) {
	root := t.TempDir()
	base := `schemaVersion: 1
sites:
  en:
    name: English
    description: Product documentation
    repository: tasuku43/git-artifact-pages
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
		"registry", "register",
		"--config", "artifact-pages.yaml",
		"--config", "artifact-pages.local.yaml",
		"--dry-run", "--format", "json",
	})
	var result publisher.Result
	if err := json.Unmarshal([]byte(stdout), &result); err != nil {
		t.Fatalf("decode layered config result: %v; stdout=%s stderr=%s", err, stdout, stderr)
	}
	if exitCode != 0 || result.Operation != "registry register" || result.Outcome != "planned" || len(result.Changes) != 3 {
		t.Fatalf("layered registry dry-run = exit %d, %+v; stderr=%s, want inherited site and local target", exitCode, result, stderr)
	}
	if _, err := os.Stat(filepath.Join(root, ".local", "storage")); !os.IsNotExist(err) {
		t.Fatalf("layered dry-run created local storage: stat error = %v", err)
	}
}

func TestPublishCommandHelpIsProviderNeutral(t *testing.T) {
	for _, args := range [][]string{{"site", "publish", "--help"}, {"app", "deploy", "--help"}} {
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
	if err := run(t.Context(), []string{"site", "publish", "--help"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(site publish --help) error = %v", err)
	}
	if help := stdout.String() + stderr.String(); !strings.Contains(help, "stale preview references") {
		t.Errorf("site publish dry-run help does not mention stale preview references:\n%s", help)
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
	if err := run(t.Context(), []string{"site", "publish", "--site", "sre", "--source", "docs/artifacts"}, &stdout, &stderr); err != nil {
		t.Fatalf("run(site publish) error = %v; stderr=%s", err, stderr.String())
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

	args := []string{"site", "publish", "--site", "sre", "--source", "docs/artifacts", "--dry-run", "--format", "json"}
	stdout, stderr, exitCode := runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("site publish dry-run exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
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
		t.Fatalf("decode site publish dry-run JSON: %v; output=%s", err, stdout)
	}
	wantChanges := []publisher.Change{
		{Action: "update", Path: "_artifacts/sre/overview.html"},
		{Action: "remove", Path: "_artifacts/sre/stale.html"},
		{Action: "create", Path: "_indexes/sre/index.json"},
		{Action: "create", Path: "_indexes/sre/meta.json"},
	}
	if planned.Operation != "site publish" || planned.Outcome != "planned" || planned.Site != "sre" || planned.FilesPublished != 3 || planned.FilesRemoved != 1 || !reflect.DeepEqual(planned.Changes, wantChanges) {
		t.Fatalf("site publish dry-run result = %+v, want planned creates %+v", planned, wantChanges)
	}
	wantPreviewChanges := []struct {
		Action  string `json:"action"`
		GroupID string `json:"groupId"`
		HeadSHA string `json:"headSha"`
		Reason  string `json:"reason"`
	}{{Action: "remove", GroupID: "pr:42", HeadSHA: staleHeadSHA, Reason: "manifest-missing"}}
	if !reflect.DeepEqual(planned.PreviewChanges, wantPreviewChanges) {
		t.Fatalf("site publish dry-run previewChanges = %+v, want %+v", planned.PreviewChanges, wantPreviewChanges)
	}
	if afterDryRun := snapshotFiles(t, storageRoot); !reflect.DeepEqual(afterDryRun, beforeDryRun) {
		t.Fatalf("site publish dry-run changed local storage: before=%v after=%v", beforeDryRun, afterDryRun)
	}
	unchangedCatalog, err := os.ReadFile(staleCatalogPath)
	if err != nil || !bytes.Equal(unchangedCatalog, staleCatalog) {
		t.Fatalf("site publish dry-run changed preview catalog: got=%q err=%v, want original bytes", unchangedCatalog, err)
	}

	args = []string{"site", "publish", "--site", "sre", "--source", "docs/artifacts", "--format", "json"}
	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("site publish exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var published publisher.Result
	if err := json.Unmarshal([]byte(stdout), &published); err != nil {
		t.Fatalf("decode site publish JSON: %v; output=%s", err, stdout)
	}
	if published.Operation != "site publish" || published.Outcome != "published" || published.Site != "sre" || published.FilesPublished != 3 || published.FilesRemoved != 1 || !reflect.DeepEqual(published.Changes, wantChanges) {
		t.Fatalf("site publish result = %+v, want published result with changes %+v", published, wantChanges)
	}
	artifact, err := os.ReadFile(filepath.Join(storageRoot, "_artifacts", "sre", "overview.html"))
	if err != nil || string(artifact) != "<title>Overview</title><h1>Overview</h1>" {
		t.Fatalf("published local artifact = %q, err=%v", artifact, err)
	}
	if _, err := os.Stat(staleArtifactPath); !os.IsNotExist(err) {
		t.Fatalf("stale local artifact remains after publish: stat error = %v", err)
	}

	textDryRunArgs := []string{"site", "publish", "--site", "sre", "--source", "docs/artifacts", "--dry-run"}
	stdout, stderr, exitCode = runCLIProcess(t, root, textDryRunArgs)
	if exitCode != 0 {
		t.Fatalf("site publish text dry-run no-op exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	for _, expected := range []string{
		"site publish sre  DRY RUN",
		"+ 0 create   ~ 0 update   - 0 remove",
		"Dry run complete. No writes.",
	} {
		if !strings.Contains(stdout, expected) {
			t.Errorf("site publish text dry-run no-op output is missing %q:\n%s", expected, stdout)
		}
	}

	stdout, stderr, exitCode = runCLIProcess(t, root, args)
	if exitCode != 0 {
		t.Fatalf("site publish no-op exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
	}
	var noOp publisher.Result
	if err := json.Unmarshal([]byte(stdout), &noOp); err != nil {
		t.Fatalf("decode site publish no-op JSON: %v; output=%s", err, stdout)
	}
	if noOp.Operation != "site publish" || noOp.Outcome != "no-op" || noOp.Site != "sre" || noOp.Changes == nil || len(noOp.Changes) != 0 || noOp.PreviewChanges == nil || len(*noOp.PreviewChanges) != 0 {
		t.Fatalf("site publish no-op result = %+v, want an empty machine-readable no-op", noOp)
	}
	assertEmptyPreviewChangesField(t, stdout)
}

func TestRegistryUnregisterLocalCLIIsScopedRetryableAndMachineReadable(t *testing.T) {
	t.Run("help exposes provider-neutral config locator", func(t *testing.T) {
		var stdout, stderr bytes.Buffer
		if err := run(t.Context(), []string{"registry", "unregister", "--help"}, &stdout, &stderr); err != nil {
			t.Fatalf("run(registry unregister --help) error = %v", err)
		}
		help := stdout.String() + stderr.String()
		for _, expected := range []string{"registry unregister --site ID", "--config LOCATOR", "--dry-run", "--format text|json"} {
			if !strings.Contains(help, expected) {
				t.Errorf("registry unregister help is missing %q:\n%s", expected, help)
			}
		}
	})

	t.Run("dry-run and successful forced cleanup", func(t *testing.T) {
		root := createLocalUnregisterCheckout(t)
		storageRoot := filepath.Join(root, ".local", "storage")
		before := snapshotFiles(t, storageRoot)
		args := []string{"registry", "unregister", "--site", "sre", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json"}
		stdout, stderr, exitCode := runCLIProcess(t, root, args)
		if exitCode != 0 {
			t.Fatalf("registry unregister dry-run exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var planned publisher.Result
		if err := json.Unmarshal([]byte(stdout), &planned); err != nil {
			t.Fatalf("decode registry unregister dry-run JSON: %v; output=%s", err, stdout)
		}
		if planned.Operation != "registry unregister" || planned.Outcome != "planned" || planned.Site != "sre" || planned.RegistryUpdated == nil || *planned.RegistryUpdated {
			t.Fatalf("registry unregister dry-run = %+v; want explicit site and a read-only plan", planned)
		}
		for _, expected := range []string{
			"_artifacts/sre/report.html", "_indexes/sre/index.json", "_previews/sre/catalog.json",
		} {
			if !containsChange(planned.Changes, "remove", expected) {
				t.Errorf("unregister plan does not remove %q: %+v", expected, planned.Changes)
			}
		}
		if after := snapshotFiles(t, storageRoot); !reflect.DeepEqual(after, before) {
			t.Fatalf("dry-run changed local storage: before=%v after=%v", before, after)
		}

		args = []string{"registry", "unregister", "--site", "sre", "--config", "artifact-pages.yaml", "--format", "json"}
		stdout, stderr, exitCode = runCLIProcess(t, root, args)
		if exitCode != 0 {
			t.Fatalf("registry unregister exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var applied publisher.Result
		if err := json.Unmarshal([]byte(stdout), &applied); err != nil {
			t.Fatalf("decode registry unregister JSON: %v; output=%s", err, stdout)
		}
		if applied.Operation != "registry unregister" || applied.Outcome != "unregistered" || applied.Site != "sre" || applied.RegistryUpdated == nil || !*applied.RegistryUpdated || applied.FilesRemoved != 6 {
			t.Fatalf("registry unregister = %+v; want committed registry, selected site, and six removed objects", applied)
		}
		if !reflect.DeepEqual(applied.Changes, planned.Changes) {
			t.Fatalf("registry unregister changes = %+v, dry-run changes = %+v", applied.Changes, planned.Changes)
		}
		assertLocalUnregisterResult(t, storageRoot, "sre")

		// Repeating the explicit cleanup after withdrawal must still succeed,
		// revalidate the target, and leave the retained control locks intact.
		stdout, stderr, exitCode = runCLIProcess(t, root, args)
		if exitCode != 0 {
			t.Fatalf("repeated registry unregister exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var retried publisher.Result
		if err := json.Unmarshal([]byte(stdout), &retried); err != nil {
			t.Fatalf("decode repeated registry unregister JSON: %v; output=%s", err, stdout)
		}
		if retried.Operation != "registry unregister" || retried.Outcome != "unregistered" || retried.Site != "sre" || retried.RegistryUpdated == nil || *retried.RegistryUpdated || retried.FilesRemoved != 0 {
			t.Fatalf("repeated registry unregister = %+v; want idempotent forced cleanup with no registry rewrite", retried)
		}
		assertLocalUnregisterResult(t, storageRoot, "sre")
	})

	t.Run("listing failure after withdrawal retries from the retained record", func(t *testing.T) {
		root := createLocalUnregisterCheckout(t)
		storageRoot := filepath.Join(root, ".local", "storage")
		artifactPrefix := filepath.Join(storageRoot, "_artifacts", "sre")
		if err := os.RemoveAll(artifactPrefix); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(artifactPrefix, []byte("block the listing directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		args := []string{"registry", "unregister", "--site", "sre", "--format", "json"}
		stdout, stderr, exitCode := runCLIProcess(t, root, args)
		if exitCode != 1 {
			t.Fatalf("registry unregister listing failure exit code = %d, want 1; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var failure struct {
			publisher.Result
			Error string `json:"error"`
		}
		if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
			t.Fatalf("decode registry unregister failure JSON: %v; output=%s", err, stdout)
		}
		if failure.Operation != "registry unregister" || failure.Outcome != "failed" || failure.Site != "sre" || failure.RegistryUpdated == nil || !*failure.RegistryUpdated || !strings.Contains(failure.Error, "list site \"sre\" for cleanup") {
			t.Fatalf("registry unregister failure = %+v; want committed withdrawal and retryable listing error", failure)
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
			t.Fatalf("registry unregister retry exit code = %d, want 0; stdout=%s stderr=%s", exitCode, stdout, stderr)
		}
		var retried publisher.Result
		if err := json.Unmarshal([]byte(stdout), &retried); err != nil {
			t.Fatalf("decode registry unregister retry JSON: %v; output=%s", err, stdout)
		}
		if retried.Outcome != "unregistered" || retried.Site != "sre" || retried.RegistryUpdated == nil || *retried.RegistryUpdated || retried.FilesRemoved != 6 {
			t.Fatalf("registry unregister retry = %+v; want completed cleanup without a second registry write", retried)
		}
		if _, err := os.Stat(filepath.Join(storageRoot, "_control", "registry-cleanup.json")); !os.IsNotExist(err) {
			t.Fatalf("registry cleanup record remains after retry: stat err=%v", err)
		}
		assertLocalUnregisterResult(t, storageRoot, "sre")
	})

	t.Run("invalid site ID and config entry are argument errors", func(t *testing.T) {
		root := createLocalUnregisterCheckout(t)
		for _, test := range []struct {
			name     string
			siteID   string
			config   string
			wantText string
		}{
			{name: "invalid site ID", siteID: "../sre", config: localUnregisterManifest, wantText: "invalid site ID"},
			{name: "site still registered in config", siteID: "sre", config: localRegistryBeforeUnregister, wantText: "still present in config sites"},
		} {
			t.Run(test.name, func(t *testing.T) {
				configPath := filepath.Join(root, "artifact-pages.yaml")
				if err := os.WriteFile(configPath, []byte(test.config), 0o600); err != nil {
					t.Fatal(err)
				}
				before := snapshotFiles(t, filepath.Join(root, ".local", "storage"))
				args := []string{"registry", "unregister", "--site", test.siteID, "--config", "artifact-pages.yaml", "--format", "json"}
				stdout, stderr, exitCode := runCLIProcess(t, root, args)
				if exitCode != 2 {
					t.Fatalf("registry unregister argument error exit code = %d, want 2; stdout=%s stderr=%s", exitCode, stdout, stderr)
				}
				var failure struct {
					publisher.Result
					Error string `json:"error"`
				}
				if err := json.Unmarshal([]byte(stdout), &failure); err != nil {
					t.Fatalf("decode registry unregister argument error JSON: %v; output=%s", err, stdout)
				}
				if failure.Operation != "registry unregister" || failure.Outcome != "failed" || failure.Site != test.siteID || failure.Changes == nil || failure.Error == "" {
					t.Fatalf("registry unregister argument error result = %+v; want operation/site/failed outcome and an empty change list", failure)
				}
				if !strings.Contains(failure.Error, test.wantText) {
					t.Fatalf("registry unregister error %q does not contain %q", failure.Error, test.wantText)
				}
				if after := snapshotFiles(t, filepath.Join(root, ".local", "storage")); !reflect.DeepEqual(after, before) {
					t.Fatalf("argument error changed storage: before=%v after=%v", before, after)
				}
			})
		}
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
		key := "_control/locks/sites/" + siteID + ".json"
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
	for _, key := range []string{"_control/locks/sites/sre.json", "_control/locks/sites/docs.json", "_control/locks/registry.json"} {
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

		stdout, stderr, exitCode := runCLIProcess(t, root, []string{"site", "publish", "--site", "sre", "--config", "deployment.yaml", "--format", "json"})
		if exitCode != 2 {
			t.Fatalf("site publish malformed-config exit code = %d, want 2; stdout=%s stderr=%s", exitCode, stdout, stderr)
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
		if failure.Operation != "site publish" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Changes == nil || !strings.Contains(failure.Error, "apiToken") {
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
		stdout, stderr, exitCode := runCLIProcess(t, root, []string{"site", "publish", "--site", "sre", "--source", "docs/artifacts", "--config", "artifact-pages.yaml", "--format", "json"})
		if exitCode != 1 {
			t.Fatalf("site publish unregistered-site exit code = %d, want 1; stdout=%s stderr=%s", exitCode, stdout, stderr)
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
		if failure.Operation != "site publish" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Changes == nil || !strings.Contains(failure.Error, "is not registered") {
			t.Fatalf("unregistered-site failure result = %+v, want stable failure envelope", failure)
		}
		assertEmptyPreviewChangesField(t, stdout)
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

		stdout, stderr, exitCode := runCLIProcess(t, root, []string{"site", "publish", "--site", "sre", "--source", "docs/artifacts", "--format", "json"})
		if exitCode != 1 {
			t.Fatalf("site publish provider-read exit code = %d, want 1; stdout=%s stderr=%s", exitCode, stdout, stderr)
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
		if failure.Operation != "site publish" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Changes == nil || failure.PreviewChanges == nil || !strings.Contains(failure.Error, "read deployed site registry") {
			t.Fatalf("provider-read failure result = %+v, want stable site-publish failure envelope", failure)
		}
		assertEmptyPreviewChangesField(t, stdout)
	})
}

func assertEmptyPreviewChangesField(t *testing.T, output string) {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(output), &fields); err != nil {
		t.Fatalf("decode site publish JSON fields: %v; output=%s", err, output)
	}
	previewChanges, exists := fields["previewChanges"]
	if !exists || string(previewChanges) != "[]" {
		t.Fatalf("site publish previewChanges JSON = %q (present=%t), want []", previewChanges, exists)
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
	result := publisher.Result{Operation: "site publish", Outcome: "planned", Changes: []publisher.Change{}}

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
	if encoded["configCommitSha"] != sha || encoded["operation"] != "site publish" {
		t.Fatalf("JSON result = %v, want operation, target, and resolved config SHA", encoded)
	}
	if _, nested := encoded["Result"]; nested {
		t.Fatalf("JSON result unexpectedly nests operation fields: %v", encoded)
	}

	var textOutput bytes.Buffer
	reportDeploymentConfig(&textOutput, resolved)
	wantText := "Deployment target: AWS S3 bucket artifact-pages-123456789012-us-east-1 (region us-east-1, account 123456789012)\nDeployment config commit: " + sha + "\n"
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
	if err := encodeDeploymentResult(&output, publisher.Result{Operation: "registry register", Outcome: "planned", Changes: []publisher.Change{}}, resolved); err != nil {
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
	reportDeploymentConfig(&text, resolved)
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
	err = run(t.Context(), []string{"site", "publish", "--site", "sre", "--source", "docs", "--config", configPath}, &stdout, &stderr)
	if err == nil {
		t.Fatal("run(site publish) succeeded with malformed config")
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
	if !strings.Contains(stdout.String(), "Artifact Pages web test-1 is already current via local.") {
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
