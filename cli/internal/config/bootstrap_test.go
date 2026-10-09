package config

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBootstrapToleratesFutureSchemaAndUnknownFields(t *testing.T) {
	layers := [][]byte{[]byte("schemaVersion: 99\nfuture: [a, b]\ncli:\n  version: 0.2.0\n  future: true\n"), []byte("schemaVersion: 99\nother: unknown\n")}
	c, err := parseBootstrapLayers(layers, false)
	if err != nil || c.CLI.Version != "0.2.0" {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err = ParseLayers(layers); err == nil {
		t.Fatal("strict parser accepted future config")
	}
}
func TestBootstrapVersionLayerValidation(t *testing.T) {
	for _, body := range []string{"cli: null", "cli: [x]", "cli: {version: latest}", "cli: {version: 01.0.0}", "cli: {version: 0.1.0-rc.1}", "cli: {version: 0.1.0, version: 0.2.0}", "cli: {version: 0.1.0}\ncli: {version: 0.2.0}", "web: {version: 0.1.0+meta}"} {
		if _, err := parseBootstrapLayers([][]byte{[]byte(body)}, false); err == nil {
			t.Errorf("accepted %s", body)
		}
	}
	for _, second := range []string{"cli: {version: 0.1.0}", "web: {version: 0.1.0}"} {
		if _, err := parseBootstrapLayers([][]byte{[]byte("cli: {version: 0.1.0}"), []byte(second)}, false); err == nil || !strings.Contains(err.Error(), "at most one") {
			t.Fatalf("%v", err)
		}
	}
}
func TestBootstrapLocatorPrecedenceAndLayers(t *testing.T) {
	dir := t.TempDir()
	saved := t.TempDir()
	write := func(name, version string) string {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte("schemaVersion: 999\ncli: {version: "+version+"}\n"), 0600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	repo := write("artifact-pages.yaml", "0.1.0")
	env := write("env.yaml", "0.2.0")
	explicit := write("explicit.yaml", "0.3.0")
	r := Resolver{WorkingDir: dir, ConfigDir: saved, Getenv: func(k string) string {
		if k == ConfigEnvironment {
			return env
		}
		return ""
	}}
	v, err := r.ResolveCLIVersion(context.Background(), []string{explicit})
	if err != nil || v != "0.3.0" {
		t.Fatalf("%s %v", v, err)
	}
	v, err = r.ResolveCLIVersion(context.Background(), nil)
	if err != nil || v != "0.2.0" {
		t.Fatalf("%s %v", v, err)
	}
	r.Getenv = func(string) string { return "" }
	v, err = r.ResolveCLIVersion(context.Background(), nil)
	if err != nil || v != "0.1.0" {
		t.Fatalf("%s %v", v, err)
	}
	if err = os.Remove(repo); err != nil {
		t.Fatal(err)
	}
	if _, err = r.SetDefault(explicit); err != nil {
		t.Fatal(err)
	}
	v, err = r.ResolveCLIVersion(context.Background(), nil)
	if err != nil || v != "0.3.0" {
		t.Fatalf("%s %v", v, err)
	}
	partial := filepath.Join(dir, "partial.yaml")
	os.WriteFile(partial, []byte("schemaVersion: 999\nfuture: true\n"), 0600)
	v, err = r.ResolveCLIVersion(context.Background(), []string{partial, explicit})
	if err != nil || v != "0.3.0" {
		t.Fatalf("%s %v", v, err)
	}
}

func TestBootstrapRemoteUsesPrivateConfigTokenForConfigOnly(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	body := []byte("schemaVersion: 999\nunknown: future\ncli: {version: 0.1.8}\n")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer private-config-test-token" {
			t.Fatal("config token missing")
		}
		if r.URL.Query().Get("ref") != sha || r.URL.Path != "/repos/acme/admin/contents/artifact-pages.yaml" {
			t.Fatal(r.URL)
		}
		json.NewEncoder(w).Encode(map[string]string{"type": "file", "encoding": "base64", "content": base64.StdEncoding.EncodeToString(body)})
	}))
	defer server.Close()
	resolver := Resolver{GitHubAPIBaseURL: server.URL, HTTPClient: server.Client(), Getenv: func(k string) string {
		if k == "GITHUB_TOKEN" {
			return "private-config-test-token"
		}
		if k == "ARTIFACT_PAGES_DOWNLOAD_TOKEN" {
			return "workflow-test-token"
		}
		return ""
	}}
	v, err := resolver.ResolveCLIVersion(t.Context(), []string{"github://acme/admin?ref=" + sha})
	if err != nil || v != "0.1.8" {
		t.Fatal(v, err)
	}
}
