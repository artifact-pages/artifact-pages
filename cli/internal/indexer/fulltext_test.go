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
	opts := BuildOptions{SiteID: "sre", SourceDir: "artifacts", OutputDir: ".local/storage", FullText: true}
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
	opts.FullText = false
	last, err := Build(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	readMeta()
	if meta.FullTextURL != "" || last.SearchBytes != 0 || len(last.SearchFiles) != 0 {
		t.Fatal("disabled build retains search pointer or metrics")
	}
	entries, err := os.ReadDir(searchDir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "caller-owned.txt" {
		t.Fatalf("cleanup affected caller files: %v, %v", entries, err)
	}
}
