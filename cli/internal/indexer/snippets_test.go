package indexer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/fulltext"
)

type snippetVectorFixture struct {
	Name     string               `json:"name"`
	Paths    []string             `json:"paths"`
	Sections fulltext.ObjectRef   `json:"sections"`
	Texts    []fulltext.ObjectRef `json:"texts"`
}

func TestBuildWritesSourceSnippetVectors(t *testing.T) {
	workingDirectory, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	fixtureRoot := filepath.Join(workingDirectory, "..", "fulltext", "testdata")
	encodedVectors, err := os.ReadFile(filepath.Join(fixtureRoot, "snippet-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []snippetVectorFixture
	if err := json.Unmarshal(encodedVectors, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		if vector.Name != "F4a Markdown heading levels" && vector.Name != "F4b HTML id-less heading" && vector.Name != "F5 empty sections" {
			continue
		}
		t.Run(vector.Name, func(t *testing.T) {
			root := initializeGitRepository(t)
			fixtureName := filepath.Base(vector.Paths[0])
			source, err := os.ReadFile(filepath.Join(fixtureRoot, fixtureName))
			if err != nil {
				t.Fatal(err)
			}
			writeFixtureFile(t, root, filepath.Join("artifacts", fixtureName), string(source))
			commitFixture(t, root, "add snippet vector source", time.Date(2026, 5, 6, 7, 8, 9, 0, time.UTC))
			restore := chdirForTest(t, root)
			defer restore()

			_, err = Build(context.Background(), BuildOptions{
				SiteID: "sre", SourceDir: "artifacts", OutputDir: ".local/storage",
				Now: func() time.Time { return time.Date(2026, 5, 7, 8, 9, 10, 0, time.UTC) },
			})
			if err != nil {
				t.Fatalf("Build() error = %v", err)
			}
			searchDirectory := filepath.Join(root, ".local", "storage", "_indexes", "sre", "search")
			manifestBytes, err := os.ReadFile(filepath.Join(searchDirectory, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			var manifest fulltext.Manifest
			if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
				t.Fatal(err)
			}
			if manifest.Sections == nil || !reflect.DeepEqual(*manifest.Sections, vector.Sections) || !reflect.DeepEqual(manifest.Texts, vector.Texts) {
				t.Fatalf("generated snippet refs differ from %s: sections=%+v texts=%+v", vector.Name, manifest.Sections, manifest.Texts)
			}
			refs := append([]fulltext.ObjectRef{vector.Sections}, vector.Texts...)
			for _, ref := range refs {
				name := filepath.Base(ref.URL)
				got, err := os.ReadFile(filepath.Join(searchDirectory, name))
				if err != nil {
					t.Fatalf("read generated %s: %v", name, err)
				}
				want, err := os.ReadFile(filepath.Join(fixtureRoot, name))
				if err != nil {
					t.Fatalf("read fixture %s: %v", name, err)
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("generated %s differs from the source vector fixture", name)
				}
			}
		})
	}
}

func TestSearchSectionsUseTOCQualificationAndHonorExtractionExclusions(t *testing.T) {
	source := []byte(`<html><body>
<h1>No ID</h1>
<h2 id="empty-text"> <span></span> </h2>
<h3>Text but no ID</h3>
<section hidden><h2 id="hidden">Hidden heading</h2><p>Hidden body</p></section>
<h2 id="visible">Visible heading</h2><p>Visible body</p>
</body></html>`)
	metadata, searchText, sections, err := readArtifactWithSearchBytes(source, "page.html")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(metadata.toc, []TOCEntry{
		{Level: 2, Text: "Hidden heading", ID: "hidden"},
		{Level: 2, Text: "Visible heading", ID: "visible"},
	}) {
		t.Fatalf("TOC = %+v", metadata.toc)
	}
	if len(sections) != 2 || sections[0].Heading != "" || sections[1].Heading != "Visible heading" || sections[1].Anchor != "visible" {
		t.Fatalf("sections include a hidden, id-less, or empty heading: %+v", sections)
	}
	if !strings.Contains(searchText, "visible heading") || strings.Contains(searchText, "hidden") {
		t.Fatalf("search text = %q; hidden content must remain excluded", searchText)
	}
}

func TestPruneSearchFilesRemovesStaleSectionAndTextPacks(t *testing.T) {
	directory := t.TempDir()
	keepSections := "sections-" + strings.Repeat("a", 64) + ".gz"
	keepText := "text-" + strings.Repeat("b", 64) + ".gz"
	staleSections := "sections-" + strings.Repeat("c", 64) + ".gz"
	staleText := "text-" + strings.Repeat("d", 64) + ".gz"
	for _, name := range []string{keepSections, keepText, staleSections, staleText, "notes.txt"} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := pruneSearchFiles(directory, []string{keepSections, keepText}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{keepSections, keepText, "notes.txt"} {
		if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
			t.Errorf("expected %s to remain: %v", name, err)
		}
	}
	for _, name := range []string{staleSections, staleText} {
		if _, err := os.Stat(filepath.Join(directory, name)); !os.IsNotExist(err) {
			t.Errorf("stale pack %s remains; stat error=%v", name, err)
		}
	}
}
