package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// isolateConfigResolution moves the working directory and every other config
// source (environment, home, user config directory) into an empty temp dir so a
// test controls exactly which config, if any, a bare command can resolve.
func isolateConfigResolution(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	t.Setenv("ARTIFACT_PAGES_CONFIG", "")
	t.Setenv("HOME", root)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(root, "xdg"))
	work := filepath.Join(root, "work")
	if err := os.Mkdir(work, 0o700); err != nil {
		t.Fatal(err)
	}
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(work); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(previous) })
	return work
}

func TestBareApplyCommandsFailWithoutResolvableConfig(t *testing.T) {
	for _, args := range [][]string{
		{"app", "deploy"},
		{"registry", "sync"},
		{"app", "remove"},
		{"site", "sync"},
		{"preview", "publish"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			isolateConfigResolution(t)
			var stdout, stderr bytes.Buffer
			err := run(t.Context(), args, &stdout, &stderr)
			if err == nil {
				t.Fatalf("run(%v) succeeded; want a non-zero failure\nstdout=%s", args, stdout.String())
			}
			if strings.Contains(stdout.String(), "Usage:") {
				t.Errorf("run(%v) printed usage instead of failing:\n%s", args, stdout.String())
			}
		})
	}
}

func TestBareConfigCommandsReportMissingConfigClearly(t *testing.T) {
	for _, args := range [][]string{{"app", "deploy"}, {"registry", "sync"}} {
		isolateConfigResolution(t)
		var stdout, stderr bytes.Buffer
		err := run(t.Context(), args, &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "no deployment config found") {
			t.Errorf("run(%v) error = %v, want the no-config message", args, err)
		}
	}
}

func TestBareRegistryRegisterRunsWithRepositoryLocalConfig(t *testing.T) {
	work := isolateConfigResolution(t)
	config := "schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\nsites:\n  sre:\n    name: SRE\n    repository: acme/sre\n    sourcePath: docs/artifacts\n"
	if err := os.WriteFile(filepath.Join(work, "artifact-pages.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"registry", "sync"}, &stdout, &stderr); err != nil {
		t.Fatalf("bare registry sync error = %v; stderr=%s", err, stderr.String())
	}
	if strings.Contains(stdout.String(), "Usage:") {
		t.Errorf("bare registry sync printed usage:\n%s", stdout.String())
	}
	if _, err := os.Stat(filepath.Join(work, ".local", "storage", "_indexes", "sites.json")); err != nil {
		t.Fatalf("bare registry sync did not write the registry: %v", err)
	}
}

func TestBareRegistryRegisterRunsWithEnvironmentConfig(t *testing.T) {
	work := isolateConfigResolution(t)
	config := "schemaVersion: 1\nprovider: local\nlocal:\n  root: store\nsites: {}\n"
	path := filepath.Join(work, "other.yaml")
	if err := os.WriteFile(path, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ARTIFACT_PAGES_CONFIG", path)
	var stdout, stderr bytes.Buffer
	if err := run(t.Context(), []string{"registry", "sync", "--format", "json"}, &stdout, &stderr); err != nil {
		t.Fatalf("bare registry sync error = %v", err)
	}
	if !strings.Contains(stdout.String(), `"outcome"`) {
		t.Errorf("expected a result, got:\n%s", stdout.String())
	}
}

func TestBareAppDeployResolvesConfigBeforeRunning(t *testing.T) {
	work := isolateConfigResolution(t)
	// An invalid config proves the command went on to resolve it rather than print help.
	if err := os.WriteFile(filepath.Join(work, "artifact-pages.yaml"), []byte("schemaVersion: 99\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	err := run(t.Context(), []string{"app", "deploy"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "deployment config") {
		t.Fatalf("bare app deploy error = %v, want a config error", err)
	}
}

func TestBareFlagRequiringCommandsFailOnMissingFlag(t *testing.T) {
	work := isolateConfigResolution(t)
	config := "schemaVersion: 1\nprovider: local\nlocal:\n  root: store\nsites: {}\n"
	if err := os.WriteFile(filepath.Join(work, "artifact-pages.yaml"), []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"site", "sync"}, {"preview", "publish"}} {
		var stdout, stderr bytes.Buffer
		err := run(t.Context(), args, &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "--site is required") {
			t.Errorf("run(%v) error = %v, want --site is required", args, err)
		}
		if strings.Contains(stdout.String(), "Usage:") {
			t.Errorf("run(%v) printed usage on stdout", args)
		}
	}
}

func TestExplicitHelpPrintsUsageAndSucceeds(t *testing.T) {
	for _, command := range [][]string{
		{"app", "deploy"},
		{"registry", "sync"},
		{"app", "remove"},
		{"site", "sync"},
		{"preview", "publish"},
	} {
		for _, flag := range []string{"--help", "-h"} {
			args := append(append([]string{}, command...), flag)
			t.Run(strings.Join(args, " "), func(t *testing.T) {
				isolateConfigResolution(t)
				var stdout, stderr bytes.Buffer
				if err := run(t.Context(), args, &stdout, &stderr); err != nil {
					t.Fatalf("run(%v) error = %v, want success", args, err)
				}
				if !strings.Contains(stdout.String(), "Usage:") || !strings.Contains(stdout.String(), strings.Join(command, " ")) {
					t.Errorf("run(%v) did not print its usage:\n%s", args, stdout.String())
				}
			})
		}
	}
}
