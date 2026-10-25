package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

const (
	testSHA     = "1111111111111111111111111111111111111111"
	legacyCache = "public, max-age=0, s-maxage=300, must-revalidate"
)

func runTool(args ...string) (int, string, string) {
	var stdout, stderr bytes.Buffer
	code := run(context.Background(), args, &stdout, &stderr)
	return code, stdout.String(), stderr.String()
}

func TestUsageAndExitCodes(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: "+filepath.Join(dir, "storage")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	badConfig := filepath.Join(dir, "bad.yaml")
	if err := os.WriteFile(badConfig, []byte("not: [valid"), 0o600); err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name string
		args []string
		code int
	}{
		{"help", []string{"--help"}, 0},
		{"unknown flag", []string{"--bogus"}, 2},
		{"missing config", []string{"--site", "sre"}, 2},
		{"missing site", []string{"--config", configPath}, 2},
		{"bad format", []string{"--config", configPath, "--site", "sre", "--format", "xml"}, 2},
		{"positional argument", []string{"--config", configPath, "--site", "sre", "extra"}, 2},
		{"unreadable config", []string{"--config", filepath.Join(dir, "missing.yaml"), "--site", "sre"}, 2},
		{"invalid config", []string{"--config", badConfig, "--site", "sre"}, 2},
		{"invalid site is a validation error", []string{"--config", configPath, "--site", "../x"}, 1},
		{"missing catalog is a no-op", []string{"--config", configPath, "--site", "sre"}, 0},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, _, _ := runTool(test.args...)
			if code != test.code {
				t.Fatalf("exit code = %d, want %d", code, test.code)
			}
		})
	}
	_, out, _ := runTool("--help")
	for _, want := range []string{"one-time", "not a product command", "site lock", "Last-Modified", "retention"} {
		if !strings.Contains(out, want) {
			t.Errorf("help is missing %q", want)
		}
	}
}

func seedLegacy(t *testing.T, root string) map[string]publisher.Object {
	t.Helper()
	backend, err := publisher.NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	catalog := preview.Catalog{
		SchemaVersion: preview.SchemaVersion, Site: "sre",
		Groups:          []preview.Group{{ID: "pr:1", Kind: "pull-request", HeadSHA: testSHA, PRURL: "https://github.com/acme/sre/pull/1", UpdatedAt: "2026-10-06T00:00:00Z", Documents: []preview.Document{}}},
		RevisionHistory: []preview.GroupRevisionHistory{{GroupID: "pr:1", Revisions: []preview.RevisionOwnership{{HeadSHA: testSHA, Files: []string{"a.md"}}}}},
	}
	manifest := preview.RevisionManifest{
		SchemaVersion: preview.SchemaVersion, Site: "sre", HeadSHA: testSHA,
		DefaultHead: strings.Repeat("d", 40), MergeBase: strings.Repeat("e", 40),
		CreatedAt: "2026-10-06T00:00:00Z", BundleDigest: "sha256:" + strings.Repeat("f", 64),
		Files:     []preview.PreviewFile{{Path: "a.md", SHA256: strings.Repeat("a", 64), ContentType: "text/markdown; charset=utf-8"}},
		Documents: []preview.Document{},
	}
	catalogBytes, err := preview.EncodeCatalog(catalog)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, err := preview.EncodeManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	seeded := map[string]publisher.Object{}
	put := func(key string, contents []byte, cache string) {
		t.Helper()
		object := publisher.Object{
			Bytes: contents, ContentType: "text/x-seeded; charset=utf-8", ContentDisposition: "inline",
			ContentEncoding: "identity", Cache: cache, Metadata: map[string]string{"artifact-pages-preview": "true"},
		}
		if err := backend.PutObject(context.Background(), key, object); err != nil {
			t.Fatal(err)
		}
		seeded[key] = object
	}
	put("_previews/sre/catalog.json", catalogBytes, "public, max-age=0, s-maxage=60, must-revalidate")
	put("_previews/sre/revisions/"+testSHA+"/manifest.json", manifestBytes, legacyCache)
	put("_previews/sre/revisions/"+testSHA+"/files/a.md", []byte("# A\n"), legacyCache)
	return seeded
}

func TestDryRunVersusApplyAgainstLocalProvider(t *testing.T) {
	dir := t.TempDir()
	root := filepath.Join(dir, "storage")
	seeded := seedLegacy(t, root)
	configPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(configPath, []byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: "+root+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	decode := func(out string) publisher.PreviewCacheMigrationResult {
		t.Helper()
		var result publisher.PreviewCacheMigrationResult
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatalf("decode %q: %v", out, err)
		}
		return result
	}
	code, out, errOut := runTool("--config", configPath, "--site", "sre", "--format", "json")
	if code != 0 {
		t.Fatalf("dry-run exit %d: %s", code, errOut)
	}
	if result := decode(out); result.Outcome != "planned" || result.Updated != 3 || result.Current != 0 || result.Site != "sre" {
		t.Fatalf("dry-run = %+v", result)
	}
	if !strings.Contains(out, `"expiredRevisions"`) || !strings.Contains(out, `"action": "update"`) {
		t.Fatalf("dry-run JSON keys missing: %s", out)
	}
	// Still dry: a second dry run reports the same plan.
	if _, out, _ := runTool("--config", configPath, "--site", "sre", "--format", "json"); decode(out).Outcome != "planned" {
		t.Fatalf("dry-run changed state: %s", out)
	}
	code, out, errOut = runTool("--config", configPath, "--site", "sre", "--apply", "--format", "json")
	if code != 0 {
		t.Fatalf("apply exit %d: %s", code, errOut)
	}
	if result := decode(out); result.Outcome != "migrated" || result.Updated != 3 {
		t.Fatalf("apply = %+v", result)
	}
	backend, err := publisher.NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	for key, want := range seeded {
		got, _, err := backend.GetObject(context.Background(), key)
		if err != nil {
			t.Fatalf("read back %s: %v", key, err)
		}
		wantCache := "public, max-age=0, s-maxage=0, must-revalidate, stale-if-error=0"
		if got.Cache != wantCache {
			t.Errorf("%s Cache = %q, want %q", key, got.Cache, wantCache)
		}
		got.Cache, want.Cache = "", ""
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s changed beyond Cache-Control: got %+v want %+v", key, got, want)
		}
	}
	code, out, _ = runTool("--config", configPath, "--site", "sre", "--apply")
	if code != 0 || !strings.Contains(out, "no-op") || !strings.Contains(out, "current 3") {
		t.Fatalf("rerun text = %q (exit %d)", out, code)
	}
}
