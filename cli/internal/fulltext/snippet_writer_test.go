package fulltext

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"golang.org/x/net/html"
)

func writerFixtureRecords() []Record {
	sources := snippetFixtureSources()
	records := make([]Record, 0, len(sources))
	for _, source := range sources {
		sections := make([]Section, 0, len(source.Sections))
		for _, section := range source.Sections {
			sections = append(sections, Section{Heading: section.Heading, Anchor: section.Anchor, Text: section.Text})
		}
		records = append(records, Record{
			Path: source.Path, Text: snippetFixtureSearchText(source), Sections: sections,
		})
	}
	return records
}

func projectionRaw(t *testing.T, projection Projection, ref ObjectRef) []byte {
	t.Helper()
	compressed, ok := projection.Files[filepath.Base(ref.URL)]
	if !ok {
		t.Fatalf("projection is missing %s", ref.URL)
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	raw, readErr := io.ReadAll(reader)
	closeErr := reader.Close()
	if readErr != nil || closeErr != nil {
		t.Fatalf("read %s: read=%v close=%v", ref.URL, readErr, closeErr)
	}
	if len(raw) != ref.RawBytes {
		t.Fatalf("%s raw bytes = %d; want %d", ref.URL, len(raw), ref.RawBytes)
	}
	return raw
}

func assertProjectionBlobsMatchTestdata(t *testing.T, projection Projection, refs []ObjectRef) {
	t.Helper()
	for _, ref := range refs {
		name := filepath.Base(ref.URL)
		want, err := os.ReadFile(filepath.Join("testdata", name))
		if err != nil {
			t.Fatalf("read expected %s: %v", name, err)
		}
		if got := projection.Files[name]; !bytes.Equal(got, want) {
			t.Errorf("generated %s differs from fixture", name)
		}
	}
}

func projectionRefs(projection Projection) []ObjectRef {
	refs := []ObjectRef{projection.Manifest.Root}
	for _, ref := range projection.Manifest.Shards {
		if ref != nil {
			refs = append(refs, *ref)
		}
	}
	if projection.Manifest.Sections != nil {
		refs = append(refs, *projection.Manifest.Sections)
	}
	refs = append(refs, projection.Manifest.Texts...)
	return refs
}

func TestCombinedSnippetProjectionMatchesGolden(t *testing.T) {
	projection, err := Build(context.Background(), "sre", writerFixtureRecords())
	if err != nil {
		t.Fatal(err)
	}
	wantManifest, err := os.ReadFile(filepath.Join("testdata", "manifest-snippets.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got := projection.Files["manifest.json"]; !bytes.Equal(got, wantManifest) {
		t.Fatalf("combined snippet manifest differs from golden\n got: %s\nwant: %s", got, wantManifest)
	}
	assertProjectionBlobsMatchTestdata(t, projection, projectionRefs(projection))
}

func snippetVectorRecords(t *testing.T, vector snippetContractVectorFixture) []Record {
	t.Helper()
	lead := func(text string) []Section { return []Section{{Text: text}} }
	switch vector.Name {
	case "F1 non-BMP offsets":
		return []Record{{Path: vector.Paths[0], Sections: []Section{{Heading: "障害対応", Anchor: "障害対応-再起動", Text: "障害対応 𠮷 😀"}}}}
	case "F2 display form":
		return []Record{{Path: vector.Paths[0], Sections: []Section{{Heading: "Artifact Pages ＡＢＣ", Anchor: "md-artifact-pages-abc", Text: "Artifact Pages ＡＢＣ"}}}}
	case "F3 scalar-boundary truncation":
		return []Record{
			{Path: vector.Paths[0], Sections: lead(strings.Repeat("a", maxSnippetDocumentBytes-2) + "界")},
			{Path: vector.Paths[1], Sections: lead(strings.Repeat("a", maxSnippetDocumentBytes-3) + "😀")},
		}
	case "F6 soft pack boundary":
		return []Record{
			{Path: vector.Paths[0], Sections: lead(strings.Repeat("a", 8192))},
			{Path: vector.Paths[1], Sections: lead(strings.Repeat("b", 8192))},
			{Path: vector.Paths[2], Sections: lead("tail")},
		}
	case "F7 Go JSON escaping":
		return []Record{{Path: vector.Paths[0], Sections: []Section{{
			Heading: "Tags <>&\u2028Next\u2029Part", Anchor: "f7-tags", Text: "Tags <>&\u2028Next\u2029Part Body",
		}}}}
	default:
		t.Fatalf("unexpected writer vector %q", vector.Name)
		return nil
	}
}

func TestSnippetWriterContractVectors(t *testing.T) {
	for _, vector := range readSnippetContractVectors(t) {
		if vector.Name != "F1 non-BMP offsets" && vector.Name != "F2 display form" &&
			vector.Name != "F3 scalar-boundary truncation" && vector.Name != "F6 soft pack boundary" &&
			vector.Name != "F7 Go JSON escaping" {
			continue
		}
		t.Run(vector.Name, func(t *testing.T) {
			projection, err := Build(context.Background(), "sre", snippetVectorRecords(t, vector))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(projection.Manifest.Sections, &vector.Sections) || !reflect.DeepEqual(projection.Manifest.Texts, vector.Texts) {
				t.Fatalf("writer refs differ from %s: sections=%+v texts=%+v", vector.Name, projection.Manifest.Sections, projection.Manifest.Texts)
			}
			refs := append([]ObjectRef{vector.Sections}, vector.Texts...)
			assertProjectionBlobsMatchTestdata(t, projection, refs)
		})
	}
}

func TestExtractDocumentWithoutSectionStartsMatchesExtractText(t *testing.T) {
	document, err := html.Parse(strings.NewReader(`<head><title>excluded</title><style>excluded</style></head><body><p>Ｃａｃｈｅ re<span>try</span> &amp; 再試行</p><p hidden>hidden</p><p aria-hidden="TRUE">hidden</p><p data-search-ignore>hidden</p><script>runtime</script><template>template</template><noscript>fallback</noscript><div>Second<br>line</div></body>`))
	if err != nil {
		t.Fatal(err)
	}
	got, sections := ExtractDocument(document, nil)
	if got != ExtractText(document) || got != "cache retry & 再試行 second line" {
		t.Fatalf("ExtractDocument text = %q; ExtractText = %q", got, ExtractText(document))
	}
	if len(sections) != 1 || Normalize(sections[0].Text) != got {
		t.Fatalf("ExtractDocument lead section = %+v", sections)
	}
}

func TestSnippetWriterFoldsAndDropsEmptySections(t *testing.T) {
	projection, err := Build(context.Background(), "sre", []Record{{Path: "fold.md", Sections: []Section{
		{Text: "\t \u3000"},
		{Heading: "Blank", Anchor: "blank", Text: " \t\u2028 "},
		{Heading: "Kept", Anchor: "kept", Text: "  Visible\t\n text  "},
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if projection.Manifest.Sections == nil || len(projection.Manifest.Texts) != 1 {
		t.Fatalf("missing snippet refs: %+v", projection.Manifest)
	}
	var table sectionTableFixture
	if err := json.Unmarshal(projectionRaw(t, projection, *projection.Manifest.Sections), &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Documents) != 1 || len(table.Documents[0].Sections) != 1 {
		t.Fatalf("empty sections were not dropped: %+v", table)
	}
	section := table.Documents[0].Sections[0]
	if section.Heading != "Kept" || section.Anchor != "kept" || section.Offset != 0 || section.Length != len("Visible text") ||
		string(projectionRaw(t, projection, projection.Manifest.Texts[0])) != "Visible text" {
		t.Fatalf("unexpected retained range: %+v", section)
	}
}

func TestSnippetWriterTruncationAtThreeAndFourByteScalars(t *testing.T) {
	vectors := readSnippetContractVectors(t)
	for _, vector := range vectors {
		if vector.Name != "F3 scalar-boundary truncation" {
			continue
		}
		projection, err := Build(context.Background(), "sre", snippetVectorRecords(t, vector))
		if err != nil {
			t.Fatal(err)
		}
		if projection.Manifest.SnippetLimits == nil || !reflect.DeepEqual(projection.Manifest.SnippetLimits.TruncatedDocuments, vector.Paths) ||
			len(projection.Manifest.SnippetLimits.OmittedDocuments) != 0 {
			t.Fatalf("truncation limits = %+v; want truncated paths %v", projection.Manifest.SnippetLimits, vector.Paths)
		}
	}
}

func TestSnippetWriterSiteCapOmitsWholeDocumentAndContinues(t *testing.T) {
	records := make([]Record, 0, 130)
	for i := 0; i < 127; i++ {
		records = append(records, Record{
			Path:     fmt.Sprintf("doc-%03d.md", i),
			Sections: []Section{{Text: strings.Repeat("x", maxSnippetDocumentBytes)}},
		})
	}
	records = append(records, Record{Path: "doc-127.md", Sections: []Section{{Text: strings.Repeat("y", maxSnippetDocumentBytes-4)}}})
	records = append(records, Record{Path: "doc-128.md", Sections: []Section{{Text: strings.Repeat("z", maxSnippetDocumentBytes)}}})
	records = append(records, Record{Path: "z-small.md", Sections: []Section{{Text: "tail"}}})
	projection, err := Build(context.Background(), "sre", records)
	if err != nil {
		t.Fatal(err)
	}
	limits := projection.Manifest.SnippetLimits
	if limits == nil || !reflect.DeepEqual(limits.OmittedDocuments, []string{"doc-128.md"}) || len(limits.TruncatedDocuments) != 0 {
		t.Fatalf("site cap limits = %+v", limits)
	}
	if projection.Manifest.Sections == nil || len(projection.Manifest.Texts) != 128 {
		t.Fatalf("site cap omitted later small document or lost snippets: %+v", projection.Manifest)
	}
	var table sectionTableFixture
	if err := json.Unmarshal(projectionRaw(t, projection, *projection.Manifest.Sections), &table); err != nil {
		t.Fatal(err)
	}
	if len(table.Documents) != 129 || table.Documents[len(table.Documents)-1].Path != "z-small.md" {
		t.Fatalf("site cap table rows = %d, last=%q", len(table.Documents), table.Documents[len(table.Documents)-1].Path)
	}
	for _, row := range table.Documents {
		if row.Path == "doc-128.md" {
			t.Fatal("site-omitted document has a section-table row")
		}
	}
	lastPack := projectionRaw(t, projection, projection.Manifest.Texts[len(projection.Manifest.Texts)-1])
	if len(lastPack) != maxSnippetPackBytes || string(lastPack[len(lastPack)-4:]) != "tail" {
		t.Fatalf("small document after site omission was not appended to the final pack: bytes=%d tail=%q", len(lastPack), lastPack[len(lastPack)-4:])
	}
	smallDocument := table.Documents[len(table.Documents)-1]
	smallSection := smallDocument.Sections[0]
	if smallDocument.Path != "z-small.md" || smallSection.Offset != maxSnippetDocumentBytes-4 || smallSection.Length != 4 {
		t.Fatalf("unexpected later-small range: %+v", smallSection)
	}

	withoutOmitted := append([]Record(nil), records[:129]...)
	withoutOmitted = append(withoutOmitted, records[129])
	comparison, err := Build(context.Background(), "sre", withoutOmitted)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(projection.Manifest.Sections, comparison.Manifest.Sections) || !reflect.DeepEqual(projection.Manifest.Texts, comparison.Manifest.Texts) {
		t.Fatal("site-omitted document changed snippet table or pack boundaries")
	}
}

func TestSnippetWriterAbsentFieldsWithoutSectionsMatchesV1(t *testing.T) {
	projection, err := Build(context.Background(), "sre", snippetFixtureRecords())
	if err != nil {
		t.Fatal(err)
	}
	want, err := os.ReadFile(filepath.Join("testdata", "manifest-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if got := projection.Files["manifest.json"]; !bytes.Equal(got, want) {
		t.Fatalf("projection without sections differs from v1 manifest\n got: %s\nwant: %s", got, want)
	}
	if projection.Manifest.Sections != nil || projection.Manifest.Texts != nil || projection.Manifest.SnippetLimits != nil {
		t.Fatalf("snippet fields are present without sections or caps: %+v", projection.Manifest)
	}
}

func TestSnippetWriterDeterminismAndPackReuse(t *testing.T) {
	base := []Record{
		{Path: "a.md", Text: "same postings", Sections: []Section{{Text: strings.Repeat("a", maxSnippetDocumentBytes)}}},
		{Path: "b.md", Text: "same postings", Sections: []Section{{Text: strings.Repeat("b", maxSnippetDocumentBytes)}}},
		{Path: "c.md", Text: "same postings", Sections: []Section{{Text: strings.Repeat("c", maxSnippetDocumentBytes)}}},
	}
	first, err := Build(context.Background(), "sre", base)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := Build(context.Background(), "sre", base)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first, repeated) {
		t.Fatal("building the same section input twice changed projection files")
	}
	changed := append([]Record(nil), base...)
	changed[1].Sections = []Section{{Text: "x" + strings.Repeat("b", maxSnippetDocumentBytes-1)}}
	second, err := Build(context.Background(), "sre", changed)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(first.Manifest.Sections, second.Manifest.Sections) {
		t.Fatal("same-length text change altered the section-table reference")
	}
	if len(first.Manifest.Texts) != 3 || len(second.Manifest.Texts) != 3 {
		t.Fatalf("hard pack boundaries did not produce three packs: first=%+v second=%+v", first.Manifest.Texts, second.Manifest.Texts)
	}
	for i := range first.Manifest.Texts {
		if i == 1 {
			if first.Manifest.Texts[i] == second.Manifest.Texts[i] {
				t.Fatal("changed document's text-pack ref stayed the same")
			}
			if bytes.Equal(first.Files[filepath.Base(first.Manifest.Texts[i].URL)], second.Files[filepath.Base(second.Manifest.Texts[i].URL)]) {
				t.Fatal("changed document's text-pack bytes stayed the same")
			}
			continue
		}
		if first.Manifest.Texts[i] != second.Manifest.Texts[i] ||
			!bytes.Equal(first.Files[filepath.Base(first.Manifest.Texts[i].URL)], second.Files[filepath.Base(second.Manifest.Texts[i].URL)]) {
			t.Fatalf("unchanged pack %d changed after a same-length text edit", i)
		}
	}

	shorter := append([]Record(nil), base...)
	shorter[1].Sections = []Section{{Text: strings.Repeat("b", maxSnippetDocumentBytes-1)}}
	third, err := Build(context.Background(), "sre", shorter)
	if err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(first.Manifest.Sections, third.Manifest.Sections) {
		t.Fatal("a section-length change did not alter the section-table reference")
	}
}

func TestSnippetWriterRejectsInvalidNonLeadSections(t *testing.T) {
	for _, invalid := range []Section{
		{Heading: "", Anchor: "anchor", Text: "body"},
		{Heading: "Heading", Anchor: "", Text: "body"},
	} {
		_, err := Build(context.Background(), "sre", []Record{{Path: "bad.md", Sections: []Section{{Text: "lead"}, invalid}}})
		if err == nil || err.Error() != `invalid search section in "bad.md"` {
			t.Fatalf("Build() error = %v; want invalid section error", err)
		}
	}
}
