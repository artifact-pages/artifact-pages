package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/bootstrap"
	"github.com/artifact-pages/artifact-pages/cli/internal/version"
)

func TestAppDeployCLIOnlyPinRequiresWebOrArchiveBeforeBackend(t *testing.T) {
	root := t.TempDir()
	configPath := filepath.Join(root, "config.yaml")
	// A valid AWS target would require live credentials if backend creation ran.
	os.WriteFile(configPath, []byte("schemaVersion: 1\nprovider: aws\naws: {region: us-east-1, bucket: example, distributionId: DIST}\ncli: {version: "+version.Product+"}\n"), 0600)
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"app", "deploy", "--config", configPath}, &stdout, &stderr)
	if commandExitCode(err) != 2 || !strings.Contains(err.Error(), "web.version or --archive") {
		t.Fatal(err)
	}
}
func TestBootstrapMainGuardAndStrictConfigAfterResolution(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "artifact-pages.yaml")
	metadata := filepath.Join(root, "metadata.json")
	t.Setenv(bootstrap.MetadataEnv, metadata)
	t.Setenv(bootstrap.ResolvedEnv, version.Product)
	t.Setenv(bootstrap.SkipEnv, "")
	t.Setenv(bootstrap.VersionEnv, "")
	os.WriteFile(path, []byte("schemaVersion: 999\ncli: {version: "+version.Product+"}\nfuture: true\n"), 0600)
	stdout, _, code := runCLIProcess(t, root, []string{"registry", "sync", "--format", "json"})
	if code != 2 || !strings.Contains(stdout, "field future not found") {
		t.Fatalf("%d %s", code, stdout)
	}
	var m bootstrap.Metadata
	data, _ := os.ReadFile(metadata)
	if err := json.Unmarshal(data, &m); err != nil || m.CLIVersion != version.Product || !m.Resolved {
		t.Fatalf("%+v %v", m, err)
	}
	t.Setenv(bootstrap.ResolvedEnv, "9.9.9")
	stdout, _, code = runCLIProcess(t, root, []string{"version", "--format", "json"})
	if code != 2 || !strings.Contains(stdout, "loop guard") {
		t.Fatalf("%d %s", code, stdout)
	}
}
func TestBootstrapOverrideStillRejectsIncompatibleStoredWeb(t *testing.T) {
	root := t.TempDir()
	storage := filepath.Join(root, "storage")
	path := filepath.Join(root, "artifact-pages.yaml")
	os.WriteFile(path, []byte("schemaVersion: 1\nprovider: local\nlocal: {root: "+storage+"}\ncli: {version: 0.1.99}\nsites: {}\n"), 0600)
	app := filepath.Join(storage, "_control", "versions", "app.json")
	os.MkdirAll(filepath.Dir(app), 0755)
	os.WriteFile(app, []byte(`{"schemaVersion":1,"webVersion":"0.1.0","reads":{"registry":[2],"site-metadata":[2],"artifact-index":[2],"full-text-manifest":[2],"preview-catalog":[2],"preview-manifest":[2]}}`), 0600)
	metadataPath := filepath.Join(root, "metadata.json")
	t.Setenv(bootstrap.MetadataEnv, metadataPath)
	t.Setenv(bootstrap.VersionEnv, version.Product)
	t.Setenv(bootstrap.ResolvedEnv, "")
	t.Setenv(bootstrap.SkipEnv, "")
	// Allow the current CLI release through the Action range so this test
	// reaches the stored-web compatibility check it is intended to exercise.
	t.Setenv(bootstrap.RangeEnv, ">=0.3.0 <0.4.0")
	stdout, _, code := runCLIProcess(t, root, []string{"registry", "sync", "--format", "json"})
	if code != 1 || !strings.Contains(stdout, "cannot read") {
		t.Fatalf("%d %s", code, stdout)
	}
	var metadata bootstrap.Metadata
	data, _ := os.ReadFile(metadataPath)
	if err := json.Unmarshal(data, &metadata); err != nil || metadata.CLIVersion != version.Product || metadata.ConfigVersion != "0.1.99" || !metadata.Override || metadata.OverrideRequested != version.Product || !metadata.Resolved {
		t.Fatalf("%+v %v", metadata, err)
	}
	if _, err := os.Stat(filepath.Join(storage, "_indexes", "sites.json")); !os.IsNotExist(err) {
		t.Fatal("incompatible override wrote registry")
	}
}
