package indexer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestBuildFullTextPointerSharedParseAndLocalCleanup(t *testing.T) {
	root := initializeGitRepository(t)
	restore := chdirForTest(t, root)
	defer restore()
	writeFixtureFile(t, root, "artifacts/日本 #?.html", "<title>Only title</title><p>bodymarker re<span>try</span></p><script>runtime</script>")
	writeFixtureFile(t, root, "artifacts/guide.md", "# Guide\n\nBody 再試行\n")
	commitFixture(t, root, "search fixtures", time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC))
	opts := BuildOptions{SiteID: "sre", SourceDir: "artifacts", OutputDir: ".local/storage"}
	first, err := Build(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	var meta SiteDiscoveryMetadata
	readMeta := func() {
		data, err := os.ReadFile(first.MetadataPath)
		if err != nil {
			t.Fatal(err)
		}
		meta = SiteDiscoveryMetadata{}
		if err := json.Unmarshal(data, &meta); err != nil {
			t.Fatal(err)
		}
	}
	readMeta()
	if meta.FullTextURL != "/_indexes/sre/search/manifest.json" || meta.ArtifactCount != 2 {
		t.Fatalf("metadata = %+v", meta)
	}
	if len(first.SearchFiles) < 2 || first.SearchBytes == 0 {
		t.Fatal("search metrics missing")
	}
	oldRoot := ""
	for _, f := range first.SearchFiles {
		if filepath.Base(f) != "manifest.json" {
			oldRoot = f
			break
		}
	}
	searchDir := filepath.Dir(oldRoot)
	if err := os.WriteFile(filepath.Join(searchDir, "caller-owned.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	writeFixtureFile(t, root, "artifacts/日本 #?.html", "<title>Changed</title><p>new text</p>")
	if _, err := Build(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(oldRoot); !os.IsNotExist(err) {
		t.Fatalf("stale blob was retained: %v", err)
	}
	readMeta()
	if meta.FullTextURL == "" {
		t.Fatal("rebuild dropped the search pointer")
	}
	entries, err := os.ReadDir(searchDir)
	caller := false
	for _, e := range entries {
		caller = caller || e.Name() == "caller-owned.txt"
	}
	if err != nil || !caller {
		t.Fatalf("cleanup affected caller files: %v, %v", entries, err)
	}
}

func TestBuildWritesWorldReadableProjectionFiles(t *testing.T) {
	root := initializeGitRepository(t)
	restore := chdirForTest(t, root)
	defer restore()
	writeFixtureFile(t, root, "artifacts/guide.md", "# Guide\n\nReadable by the web server\n")
	commitFixture(t, root, "readable fixtures", time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC))
	result, err := Build(context.Background(), BuildOptions{SiteID: "readable", SourceDir: "artifacts", OutputDir: ".local/storage"})
	if err != nil {
		t.Fatal(err)
	}
	files := append([]string{result.MetadataPath, filepath.Join(root, ".local/storage/_indexes/readable/index.json")}, result.SearchFiles...)
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil {
			t.Fatal(err)
		}
		if mode := info.Mode().Perm(); mode != 0o644 {
			t.Errorf("%s mode = %o, want 644", file, mode)
		}
	}
}

func TestBuildAlwaysWritesFullTextData(t *testing.T) {
	root := initializeGitRepository(t)
	restore := chdirForTest(t, root)
	defer restore()
	writeFixtureFile(t, root, "artifacts/a.md", "# A\n\nbody\n")
	commitFixture(t, root, "always", time.Date(2026, 10, 3, 0, 0, 0, 0, time.UTC))
	result, err := Build(context.Background(), BuildOptions{SiteID: "always", SourceDir: "artifacts", OutputDir: ".local/storage"})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(result.MetadataPath)
	if err != nil {
		t.Fatal(err)
	}
	var meta SiteDiscoveryMetadata
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatal(err)
	}
	if meta.FullTextURL != "/_indexes/always/search/manifest.json" || len(result.SearchFiles) == 0 || result.SearchBytes == 0 {
		t.Fatalf("full-text data not produced by default: %+v %+v", meta, result)
	}
}
