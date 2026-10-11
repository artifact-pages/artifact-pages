package fulltext

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"unicode/utf8"
)

const (
	snippetDocumentLimit = 256 * 1024
	snippetSiteLimit     = 32 * 1024 * 1024
	snippetPackLimit     = 256 * 1024
)

type snippetLimitsFixture struct {
	MaxDocumentBytes int      `json:"maxDocumentBytes"`
	MaxSiteBytes     int      `json:"maxSiteBytes"`
	Truncated        []string `json:"truncatedDocuments"`
	Omitted          []string `json:"omittedDocuments"`
}

type snippetManifestFixture struct {
	Generation    string                `json:"generation"`
	Version       int                   `json:"version"`
	Site          string                `json:"site"`
	Documents     int                   `json:"documents"`
	Root          ObjectRef             `json:"root"`
	Shards        []*ObjectRef          `json:"shards"`
	Sections      *ObjectRef            `json:"sections,omitempty"`
	Texts         []ObjectRef           `json:"texts,omitempty"`
	SnippetLimits *snippetLimitsFixture `json:"snippetLimits,omitempty"`
}

type sectionTableFixture struct {
	Version   int                      `json:"version"`
	Documents []sectionDocumentFixture `json:"documents"`
}

type sectionDocumentFixture struct {
	Path     string                 `json:"path"`
	Sections []sectionRecordFixture `json:"sections"`
}

type sectionRecordFixture struct {
	Heading string `json:"heading"`
	Anchor  string `json:"anchor"`
	Pack    int    `json:"pack"`
	Offset  int    `json:"offset"`
	Length  int    `json:"length"`
}

type snippetFixtureSourceSection struct {
	Text    string
	Heading string
	Anchor  string
}

type snippetFixtureSourceDocument struct {
	Path     string
	Title    string
	Sections []snippetFixtureSourceSection
}

func snippetFixtureSources() []snippetFixtureSourceDocument {
	return []snippetFixtureSourceDocument{
		{Path: "docs/help.md", Title: "shared search", Sections: []snippetFixtureSourceSection{{Text: "検索結果"}}},
		{Path: "guide.html", Title: "shared", Sections: []snippetFixtureSourceSection{
			{Text: "cache"},
			{Text: "Retry cache", Heading: "Retry", Anchor: "md-retry"},
		}},
		{Path: "large.md", Title: "shared", Sections: []snippetFixtureSourceSection{{Text: strings.Repeat("x", snippetDocumentLimit+1)}}},
		{Path: "title-only.md", Title: "titleonly"},
	}
}

func snippetFixtureSearchText(document snippetFixtureSourceDocument) string {
	parts := []string{document.Title}
	for _, section := range document.Sections {
		parts = append(parts, section.Text)
	}
	return Normalize(strings.Join(parts, " "))
}

func snippetFixtureRecords() []Record {
	sources := snippetFixtureSources()
	records := make([]Record, 0, len(sources))
	for _, document := range sources {
		records = append(records, Record{Path: document.Path, Text: snippetFixtureSearchText(document)})
	}
	return records
}

func retainedFixtureSections(sections []snippetFixtureSourceSection, limit int) []snippetFixtureSourceSection {
	retained := make([]snippetFixtureSourceSection, 0, len(sections))
	remaining := limit
	for _, section := range sections {
		text := Normalize(section.Text)
		if text == "" {
			continue
		}
		data := []byte(text)
		if len(data) > remaining {
			end := remaining
			for end > 0 && !utf8.RuneStart(data[end]) {
				end--
			}
			if end > 0 {
				section.Text = string(data[:end])
				retained = append(retained, section)
			}
			break
		}
		section.Text = text
		retained = append(retained, section)
		remaining -= len(data)
	}
	return retained
}

func readSnippetManifest(t *testing.T, name string) snippetManifestFixture {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	var manifest snippetManifestFixture
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest
}

func snippetObject(t *testing.T, site, kind string, ref ObjectRef) []byte {
	t.Helper()
	if len(ref.SHA256) != 64 || ref.URL != fmt.Sprintf("/_indexes/%s/search/%s-%s.gz", site, kind, ref.SHA256) {
		t.Fatalf("invalid %s reference: %+v", kind, ref)
	}
	if ref.SHA256 != strings.ToLower(ref.SHA256) {
		t.Fatalf("%s digest is not lowercase hexadecimal", kind)
	}
	if _, err := hex.DecodeString(ref.SHA256); err != nil {
		t.Fatalf("invalid %s digest: %v", kind, err)
	}
	name := filepath.Base(ref.URL)
	compressed, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatalf("read %s fixture: %v", name, err)
	}
	if len(compressed) != ref.Bytes {
		t.Fatalf("%s compressed bytes = %d; want %d", kind, len(compressed), ref.Bytes)
	}
	sum := sha256.Sum256(compressed)
	if got := hex.EncodeToString(sum[:]); got != ref.SHA256 {
		t.Fatalf("%s digest = %s; want %s", kind, got, ref.SHA256)
	}
	if len(compressed) < 18 || !bytes.Equal(compressed[:4], []byte{0x1f, 0x8b, 8, 0}) ||
		!bytes.Equal(compressed[4:8], []byte{0, 0, 0, 0}) || compressed[8] != 2 || compressed[9] != 255 {
		t.Fatalf("%s fixture has a non-canonical gzip header", kind)
	}
	compressedReader := bytes.NewReader(compressed)
	reader, err := gzip.NewReader(compressedReader)
	if err != nil {
		t.Fatalf("open %s gzip: %v", kind, err)
	}
	reader.Multistream(false)
	raw, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("decode %s gzip: read=%v close=%v", kind, readErr, closeErr)
	}
	if compressedReader.Len() != 0 {
		t.Fatalf("%s has trailing compressed bytes or another member", kind)
	}
	if len(raw) != ref.RawBytes {
		t.Fatalf("%s raw bytes = %d; want %d", kind, len(raw), ref.RawBytes)
	}
	return raw
}

func validateSectionFixture(table sectionTableFixture, packs [][]byte, knownPaths []string) error {
	if table.Version != 1 || len(packs) == 0 {
		return fmt.Errorf("unsupported section table or no packs")
	}
	known := make(map[string]bool, len(knownPaths))
	for _, path := range knownPaths {
		known[path] = true
	}
	cursors := make([]int, len(packs))
	used := make([]bool, len(packs))
	previousPath := ""
	lastPack := 0
	for _, document := range table.Documents {
		if !known[document.Path] || (previousPath != "" && bytes.Compare([]byte(previousPath), []byte(document.Path)) >= 0) || len(document.Sections) == 0 {
			return fmt.Errorf("invalid or unordered document path %q", document.Path)
		}
		previousPath = document.Path
		documentPack := -1
		for sectionIndex, section := range document.Sections {
			if (section.Heading == "") != (section.Anchor == "") || section.Pack < 0 || section.Pack >= len(packs) || section.Offset < 0 || section.Length <= 0 {
				return fmt.Errorf("invalid section metadata for %q", document.Path)
			}
			if section.Heading == "" && sectionIndex != 0 {
				return fmt.Errorf("lead section is not first for %q", document.Path)
			}
			if section.Pack < lastPack || section.Pack > lastPack+1 {
				return fmt.Errorf("pack order moves backwards or skips a pack at %q", document.Path)
			}
			lastPack = section.Pack
			if documentPack == -1 {
				documentPack = section.Pack
			} else if documentPack != section.Pack {
				return fmt.Errorf("document %q is split across packs", document.Path)
			}
			if section.Pack > 0 && !used[section.Pack-1] {
				return fmt.Errorf("pack order skips %d", section.Pack-1)
			}
			pack := packs[section.Pack]
			end := section.Offset + section.Length
			if section.Offset != cursors[section.Pack] || end < section.Offset || end > len(pack) {
				return fmt.Errorf("invalid or non-contiguous range in pack %d", section.Pack)
			}
			if !utf8.Valid(pack[section.Offset:end]) || !utf8Boundary(pack, section.Offset) || !utf8Boundary(pack, end) {
				return fmt.Errorf("range in pack %d is not valid UTF-8", section.Pack)
			}
			if Normalize(string(pack[section.Offset:end])) != string(pack[section.Offset:end]) {
				return fmt.Errorf("range in pack %d is not normalized", section.Pack)
			}
			cursors[section.Pack] = end
			used[section.Pack] = true
		}
	}
	for i, pack := range packs {
		if len(pack) == 0 || len(pack) > snippetPackLimit || !utf8.Valid(pack) || !used[i] || cursors[i] != len(pack) {
			return fmt.Errorf("pack %d is empty, oversized, invalid UTF-8, unused, or incompletely covered", i)
		}
	}
	return nil
}

func utf8Boundary(data []byte, offset int) bool {
	return offset == 0 || offset == len(data) || (offset > 0 && offset < len(data) && data[offset]&0xc0 != 0x80)
}

func TestV1RootAndLeafGoldenBlobsStayUnchanged(t *testing.T) {
	legacy := readSnippetManifest(t, "manifest-v1.json")
	projection, err := Build(context.Background(), "sre", snippetFixtureRecords())
	if err != nil {
		t.Fatal(err)
	}
	if projection.Manifest.Root != legacy.Root || !reflect.DeepEqual(projection.Manifest.Shards, legacy.Shards) {
		t.Fatal("adding the snippet fixture changed v1 root or leaf references")
	}
	if projection.Manifest.Generation != legacy.Generation {
		t.Fatalf("v1 generation = %s; want golden %s", projection.Manifest.Generation, legacy.Generation)
	}
	refs := []ObjectRef{legacy.Root}
	for _, ref := range legacy.Shards {
		if ref != nil {
			refs = append(refs, *ref)
		}
	}
	for _, ref := range refs {
		name := filepath.Base(ref.URL)
		want, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatalf("read v1 fixture %s: %v", name, err)
		}
		if got := projection.Files[name]; !bytes.Equal(got, want) {
			t.Fatalf("v1 blob %s changed", name)
		}
	}
}

func TestCombinedProjectionFixtureMatchesIndexedBodySource(t *testing.T) {
	sources := snippetFixtureSources()
	records := snippetFixtureRecords()
	projection, err := Build(context.Background(), "sre", records)
	if err != nil {
		t.Fatal(err)
	}
	legacy := readSnippetManifest(t, "manifest-v1.json")
	manifest := readSnippetManifest(t, "manifest-snippets.json")
	if projection.Manifest.Generation != legacy.Generation || projection.Manifest.Root != manifest.Root || !reflect.DeepEqual(projection.Manifest.Shards, manifest.Shards) {
		t.Fatal("additive snippet fixture does not extend the same indexed v1 projection")
	}
	legacyBytes, err := os.ReadFile(filepath.Join("testdata", "manifest-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(projection.Files["manifest.json"], legacyBytes) {
		t.Fatal("legacy manifest fixture is not the combined projection's exact v1 manifest")
	}
	searchTextByPath := make(map[string]string, len(records))
	for _, record := range records {
		searchTextByPath[record.Path] = record.Text
	}

	tableBytes := snippetObject(t, manifest.Site, "sections", *manifest.Sections)
	var table sectionTableFixture
	if err := json.Unmarshal(tableBytes, &table); err != nil {
		t.Fatal(err)
	}
	packs := make([][]byte, len(manifest.Texts))
	for i, ref := range manifest.Texts {
		packs[i] = snippetObject(t, manifest.Site, "text", ref)
	}
	tableByPath := make(map[string]sectionDocumentFixture, len(table.Documents))
	for _, document := range table.Documents {
		tableByPath[document.Path] = document
	}

	for _, source := range sources {
		indexedText, ok := searchTextByPath[source.Path]
		if !ok || indexedText != snippetFixtureSearchText(source) {
			t.Fatalf("v1 indexed text for %q does not include the fixture's title and source sections", source.Path)
		}
		retained := retainedFixtureSections(source.Sections, snippetDocumentLimit)
		tableDocument, ok := tableByPath[source.Path]
		if len(retained) == 0 {
			if ok {
				t.Fatalf("title-only document %q has a section row", source.Path)
			}
			continue
		}
		if !ok || len(tableDocument.Sections) != len(retained) {
			t.Fatalf("section count for %q does not match its retained source body", source.Path)
		}
		for i, expected := range retained {
			section := tableDocument.Sections[i]
			got := string(packs[section.Pack][section.Offset : section.Offset+section.Length])
			if got != expected.Text || section.Heading != expected.Heading || section.Anchor != expected.Anchor {
				t.Fatalf("section %d for %q = (%q, %q, %q); want (%q, %q, %q)", i, source.Path, got, section.Heading, section.Anchor, expected.Text, expected.Heading, expected.Anchor)
			}
			if !strings.Contains(indexedText, got) {
				t.Fatalf("stored section text for %q is absent from the v1 indexed text", source.Path)
			}
		}
	}
}

func TestAdditiveV1SnippetFixtureKeepsLegacyObjectsAndCoversItsGeneration(t *testing.T) {
	legacy := readSnippetManifest(t, "manifest-v1.json")
	manifest := readSnippetManifest(t, "manifest-snippets.json")
	if manifest.Version != 1 || manifest.Site != "sre" || manifest.Documents != legacy.Documents || manifest.Root != legacy.Root || !reflect.DeepEqual(manifest.Shards, legacy.Shards) {
		t.Fatal("snippet fixture changed the v1 format or its legacy object references")
	}
	identity := manifest
	identity.Generation = ""
	encoded, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(encoded)
	if got := hex.EncodeToString(sum[:]); got != manifest.Generation {
		t.Fatalf("generation = %s; want %s", manifest.Generation, got)
	}
	if manifest.Generation == legacy.Generation || manifest.Sections == nil || len(manifest.Texts) != 2 || manifest.SnippetLimits == nil {
		t.Fatal("additive fixture must cover the new fields and leave the legacy generation distinct")
	}
}

func TestSnippetGoldenFixtureUsesByteOffsetsAndExplicitLimits(t *testing.T) {
	manifest := readSnippetManifest(t, "manifest-snippets.json")
	if manifest.Sections == nil || manifest.SnippetLimits == nil {
		t.Fatal("snippet extension or cap record is missing")
	}
	if manifest.SnippetLimits.MaxDocumentBytes != snippetDocumentLimit || manifest.SnippetLimits.MaxSiteBytes != snippetSiteLimit {
		t.Fatalf("unexpected caps: %+v", manifest.SnippetLimits)
	}
	if manifest.SnippetLimits.Truncated == nil || manifest.SnippetLimits.Omitted == nil || !sort.StringsAreSorted(manifest.SnippetLimits.Truncated) || !sort.StringsAreSorted(manifest.SnippetLimits.Omitted) || !reflect.DeepEqual(manifest.SnippetLimits.Truncated, []string{"large.md"}) || len(manifest.SnippetLimits.Omitted) != 0 {
		t.Fatalf("unexpected fixture cap paths: %+v", manifest.SnippetLimits)
	}
	tableBytes := snippetObject(t, manifest.Site, "sections", *manifest.Sections)
	if !utf8.Valid(tableBytes) {
		t.Fatal("section table is not valid UTF-8")
	}
	var table sectionTableFixture
	if err := json.Unmarshal(tableBytes, &table); err != nil {
		t.Fatal(err)
	}
	canonicalTable, err := json.Marshal(table)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(tableBytes, canonicalTable) {
		t.Fatal("section table fixture is not compact canonical Go JSON")
	}
	packs := make([][]byte, len(manifest.Texts))
	for i, ref := range manifest.Texts {
		packs[i] = snippetObject(t, manifest.Site, "text", ref)
	}
	knownPaths := []string{"docs/help.md", "guide.html", "large.md", "title-only.md"}
	if err := validateSectionFixture(table, packs, knownPaths); err != nil {
		t.Fatal(err)
	}
	if len(table.Documents) != 3 || table.Documents[0].Path != "docs/help.md" || table.Documents[1].Path != "guide.html" || table.Documents[2].Path != "large.md" {
		t.Fatalf("unexpected section document paths: %+v", table.Documents)
	}
	sectionPaths := make(map[string]bool, len(table.Documents))
	for _, document := range table.Documents {
		sectionPaths[document.Path] = true
	}
	knownPathSet := map[string]bool{"docs/help.md": true, "guide.html": true, "large.md": true, "title-only.md": true}
	for _, path := range manifest.SnippetLimits.Truncated {
		if !knownPathSet[path] || !sectionPaths[path] {
			t.Fatalf("truncated path %q is absent from the root or section table", path)
		}
	}
	for _, path := range manifest.SnippetLimits.Omitted {
		if !knownPathSet[path] || sectionPaths[path] {
			t.Fatalf("omitted path %q is unknown or has stored section data", path)
		}
	}
	if got := string(packs[0][table.Documents[0].Sections[0].Offset : table.Documents[0].Sections[0].Offset+table.Documents[0].Sections[0].Length]); got != "検索結果" {
		t.Fatalf("Japanese section decoded as %q", got)
	}
	guideSections := table.Documents[1].Sections
	if len(guideSections) != 2 || guideSections[0].Offset != len([]byte("検索結果")) || guideSections[0].Length != len([]byte("cache")) || guideSections[1].Offset != len([]byte("検索結果cache")) || guideSections[1].Length != len([]byte("retry cache")) {
		t.Fatalf("section offsets are not UTF-8 byte offsets: %+v", guideSections)
	}
	if got := string(packs[0][guideSections[1].Offset : guideSections[1].Offset+guideSections[1].Length]); got != "retry cache" || guideSections[1].Heading != "Retry" || guideSections[1].Anchor != "md-retry" {
		t.Fatalf("heading display/search text contract mismatch: text=%q section=%+v", got, guideSections[1])
	}
	if got := len(packs[1]); got != snippetDocumentLimit {
		t.Fatalf("truncated document pack bytes = %d; want %d", got, snippetDocumentLimit)
	}
	for _, document := range table.Documents {
		if document.Path == "title-only.md" {
			t.Fatal("title-only match must not acquire synthetic body text")
		}
	}
}

func TestSectionFixtureVerifierRejectsMalformedRanges(t *testing.T) {
	manifest := readSnippetManifest(t, "manifest-snippets.json")
	tableBytes := snippetObject(t, manifest.Site, "sections", *manifest.Sections)
	var table sectionTableFixture
	if err := json.Unmarshal(tableBytes, &table); err != nil {
		t.Fatal(err)
	}
	packs := make([][]byte, len(manifest.Texts))
	for i, ref := range manifest.Texts {
		packs[i] = snippetObject(t, manifest.Site, "text", ref)
	}
	knownPaths := []string{"docs/help.md", "guide.html", "large.md", "title-only.md"}
	malformed := table
	malformed.Documents = append([]sectionDocumentFixture(nil), table.Documents...)
	malformed.Documents[0].Sections = append([]sectionRecordFixture(nil), table.Documents[0].Sections...)
	malformed.Documents[0].Sections[0].Offset++
	if err := validateSectionFixture(malformed, packs, knownPaths); err == nil {
		t.Fatal("non-contiguous section range was accepted")
	}
	malformed = table
	malformed.Documents = append([]sectionDocumentFixture(nil), table.Documents...)
	malformed.Documents[1].Sections = append([]sectionRecordFixture(nil), table.Documents[1].Sections...)
	malformed.Documents[1].Sections[0].Length = len(packs[0]) + 1
	if err := validateSectionFixture(malformed, packs, knownPaths); err == nil {
		t.Fatal("out-of-bounds section range was accepted")
	}
	invalidUTF8 := sectionTableFixture{Version: 1, Documents: []sectionDocumentFixture{{
		Path: "docs/help.md", Sections: []sectionRecordFixture{{Pack: 0, Offset: 0, Length: 1}},
	}}}
	if err := validateSectionFixture(invalidUTF8, [][]byte{[]byte("検索結果")}, knownPaths); err == nil {
		t.Fatal("range splitting a multibyte UTF-8 scalar was accepted")
	}
	malformed = table
	malformed.Documents = append([]sectionDocumentFixture(nil), table.Documents...)
	malformed.Documents[1].Sections = append([]sectionRecordFixture(nil), table.Documents[1].Sections...)
	malformed.Documents[1].Sections[1].Heading = ""
	malformed.Documents[1].Sections[1].Anchor = ""
	if err := validateSectionFixture(malformed, packs, knownPaths); err == nil {
		t.Fatal("lead section outside the first section was accepted")
	}
	backwards := sectionTableFixture{Version: 1, Documents: []sectionDocumentFixture{
		{Path: "a.md", Sections: []sectionRecordFixture{{Pack: 0, Offset: 0, Length: 1}}},
		{Path: "b.md", Sections: []sectionRecordFixture{{Pack: 1, Offset: 0, Length: 1}}},
		{Path: "c.md", Sections: []sectionRecordFixture{{Pack: 0, Offset: 1, Length: 1}}},
	}}
	if err := validateSectionFixture(backwards, [][]byte{[]byte("ac"), []byte("b")}, []string{"a.md", "b.md", "c.md"}); err == nil {
		t.Fatal("pack order moving backwards was accepted")
	}
}
