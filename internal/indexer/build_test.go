package indexer

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/html"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

func TestBuildCreatesPerSiteIndexWithoutCopyingSources(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "artifacts/index.html", "<title>Site landing page</title>")
	writeFixtureFile(t, repositoryRoot, "artifacts/overview.html", "<title>System overview</title><h1 id=summary>Overview</h1>")
	writeFixtureFile(t, repositoryRoot, "artifacts/architecture/platform/index.html", `<!doctype html><title>Platform topology</title><h1 id="overview">Overview</h1>`)
	incidentHTML := `<!doctype html>
<html><head><title>Checkout latency review</title></head><body>
<h1 id="summary">Summary</h1>
<h2 id="root-cause">Root <span>cause</span></h2>
<h2>Heading without an id</h2>
<h3 id="follow-up">Follow-up<script>ignored text</script></h3>
</body></html>`
	writeFixtureFile(t, repositoryRoot, "artifacts/incidents/checkout-latency/index.html", incidentHTML)
	writeFixtureFile(t, repositoryRoot, "artifacts/incidents/checkout-latency/diagnostics.html", `<title>Latency diagnostics</title><h1 id="signals">Signals</h1>`)
	writeFixtureFile(t, repositoryRoot, "artifacts/incidents/checkout-latency/timeline.htm", `<title>Incident timeline</title><h1 id="events">Events</h1>`)
	writeFixtureFile(t, repositoryRoot, "artifacts/runbooks/service-recovery.md", "# Service recovery\n\nA runbook.\n\n## Request path\n\n| Step | Owner |\n| --- | --- |\n| Gateway | Edge |\n\n## Recovery checks\n\n- [x] Check retries\n- [ ] Compare regions\n\n```mermaid\nflowchart LR\n  Edge --> API[API gateway]\n```\n")
	writeFixtureFile(t, repositoryRoot, "artifacts/incidents/checkout-latency/assets/css/styles.css", "body { color: navy; }\n")
	writeFixtureFile(t, repositoryRoot, "artifacts/incidents/checkout-latency/assets/data.json", `{"status":"resolved"}`)
	commitTime := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	commitFixtureWithIdentities(t, repositoryRoot, "add representative artifacts", commitTime,
		"Artifact Author", "artifact-author@example.invalid",
		"Index Builder Committer", "index-builder-committer@example.invalid",
	)
	runGit(t, repositoryRoot, "remote", "add", "origin", "git@github.com:acme/knowledge.git")

	generatedAt := time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC)
	result, err := Build(context.Background(), BuildOptions{
		SiteID:    "sre",
		SiteTitle: "SRE",
		SourceDir: "artifacts",
		OutputDir: ".local/storage",
		Now:       func() time.Time { return generatedAt },
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if result.FilesScanned != 9 {
		t.Errorf("FilesScanned = %d, want 9", result.FilesScanned)
	}
	if result.ArtifactsIndexed != 7 {
		t.Errorf("ArtifactsIndexed = %d, want 7", result.ArtifactsIndexed)
	}
	if result.OutputBytes == 0 || result.MetadataBytes == 0 || result.Elapsed <= 0 {
		t.Errorf("Build() returned empty metrics: %+v", result)
	}

	indexBytes, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/storage/_indexes/sre/index.json"))
	if err != nil {
		t.Fatalf("read generated site index: %v", err)
	}
	var index SiteIndex
	if err := json.Unmarshal(indexBytes, &index); err != nil {
		t.Fatalf("decode generated site index: %v", err)
	}
	if index.SchemaVersion != 1 || index.Site != (SiteSummary{ID: "sre", Title: "SRE"}) {
		t.Errorf("site metadata = (%d, %+v), want schema 1 and SRE", index.SchemaVersion, index.Site)
	}
	if index.PaletteScoringProfile != nil {
		t.Errorf("small index unexpectedly includes palette scoring profile: %+v", index.PaletteScoringProfile)
	}
	if index.GeneratedAt != generatedAt.Format(time.RFC3339) {
		t.Errorf("GeneratedAt = %q, want %q", index.GeneratedAt, generatedAt.Format(time.RFC3339))
	}
	metadataBytes, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/storage/_indexes/sre/meta.json"))
	if err != nil {
		t.Fatalf("read generated site discovery metadata: %v", err)
	}
	var metadata SiteDiscoveryMetadata
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		t.Fatalf("decode generated site discovery metadata: %v", err)
	}
	if metadata.ArtifactCount != 7 || metadata.ArtifactIndexURL != "/_indexes/sre/index.json" || metadata.Site != index.Site {
		t.Errorf("site discovery metadata = %+v, want seven artifacts, site summary, and artifact index URL", metadata)
	}
	if len(index.Artifacts) != 7 {
		t.Fatalf("got %d artifacts, want 7", len(index.Artifacts))
	}
	artifactsByPath := make(map[string]ArtifactIndexEntry, len(index.Artifacts))
	for _, artifact := range index.Artifacts {
		artifactsByPath[artifact.Path] = artifact
	}

	architecture := artifactsByPath["architecture/platform/index.html"]
	if architecture.ID != "architecture/platform/index.html" || architecture.Title != "Platform topology" || architecture.Format != "html" {
		t.Errorf("architecture artifact = %+v, want exact HTML source path and extracted title", architecture)
	}
	if architecture.ArtifactURL != "/_artifacts/sre/architecture/platform/index.html" {
		t.Errorf("architecture artifactUrl = %q", architecture.ArtifactURL)
	}
	if architecture.Source == nil || architecture.Source.Repository != "acme/knowledge" || architecture.Source.RepositoryURL != "https://github.com/acme/knowledge" || architecture.Source.Ref != "main" || architecture.Source.FilePath != "artifacts/architecture/platform/index.html" {
		t.Errorf("architecture source metadata = %+v", architecture.Source)
	}
	if architecture.UpdatedAt != commitTime.Format(time.RFC3339) {
		t.Errorf("architecture updatedAt = %q, want %q", architecture.UpdatedAt, commitTime.Format(time.RFC3339))
	}
	if architecture.LastCommitter == nil || architecture.LastCommitter.Name != "Index Builder Committer" {
		t.Errorf("architecture lastCommitter = %+v, want the Git committer (not author)", architecture.LastCommitter)
	}
	if len(architecture.TOC) != 1 || architecture.TOC[0] != (TOCEntry{Level: 1, Text: "Overview", ID: "overview"}) {
		t.Errorf("architecture TOC = %+v", architecture.TOC)
	}

	incident := artifactsByPath["incidents/checkout-latency/index.html"]
	if incident.ID != "incidents/checkout-latency/index.html" || incident.Title != "Checkout latency review" {
		t.Errorf("incident artifact = %+v, want extracted title and relative path", incident)
	}
	if incident.Filename != "index.html" || incident.ArtifactURL != "/_artifacts/sre/incidents/checkout-latency/index.html" {
		t.Errorf("incident file metadata = filename %q, URL %q", incident.Filename, incident.ArtifactURL)
	}
	if incident.Source == nil || incident.Source.FilePath != "artifacts/incidents/checkout-latency/index.html" {
		t.Errorf("incident source file path = %+v, want a path relative to the Git repository root", incident.Source)
	}
	wantTOC := []TOCEntry{
		{Level: 1, Text: "Summary", ID: "summary"},
		{Level: 2, Text: "Root cause", ID: "root-cause"},
		{Level: 3, Text: "Follow-up", ID: "follow-up"},
	}
	if len(incident.TOC) != len(wantTOC) {
		t.Fatalf("incident TOC = %+v, want %+v", incident.TOC, wantTOC)
	}
	for i := range wantTOC {
		if incident.TOC[i] != wantTOC[i] {
			t.Errorf("incident TOC[%d] = %+v, want %+v", i, incident.TOC[i], wantTOC[i])
		}
	}
	if incident.UpdatedAt != commitTime.Format(time.RFC3339) {
		t.Errorf("incident updatedAt = %q, want %q", incident.UpdatedAt, commitTime.Format(time.RFC3339))
	}
	if incident.LastCommitter == nil || incident.LastCommitter.Name != "Index Builder Committer" {
		t.Errorf("incident lastCommitter = %+v, want the Git committer", incident.LastCommitter)
	}

	diagnostics := artifactsByPath["incidents/checkout-latency/diagnostics.html"]
	if diagnostics.ID != "incidents/checkout-latency/diagnostics.html" || diagnostics.Path != diagnostics.ID || diagnostics.Title != "Latency diagnostics" {
		t.Errorf("named HTML artifact = %+v, want diagnostics page with its HTML title", diagnostics)
	}
	if diagnostics.Filename != "diagnostics.html" || diagnostics.ArtifactURL != "/_artifacts/sre/incidents/checkout-latency/diagnostics.html" {
		t.Errorf("named HTML file metadata = filename %q, URL %q", diagnostics.Filename, diagnostics.ArtifactURL)
	}
	if len(diagnostics.TOC) != 1 || diagnostics.TOC[0] != (TOCEntry{Level: 1, Text: "Signals", ID: "signals"}) {
		t.Errorf("named HTML TOC = %+v", diagnostics.TOC)
	}
	if diagnostics.UpdatedAt != commitTime.Format(time.RFC3339) {
		t.Errorf("diagnostics updatedAt = %q, want %q", diagnostics.UpdatedAt, commitTime.Format(time.RFC3339))
	}

	timeline := artifactsByPath["incidents/checkout-latency/timeline.htm"]
	if timeline.ID != "incidents/checkout-latency/timeline.htm" || timeline.Filename != "timeline.htm" || timeline.ArtifactURL != "/_artifacts/sre/incidents/checkout-latency/timeline.htm" {
		t.Errorf(".htm artifact = %+v", timeline)
	}
	overview := artifactsByPath["overview.html"]
	if overview.ID != "overview.html" || overview.Filename != "overview.html" || overview.ArtifactURL != "/_artifacts/sre/overview.html" {
		t.Errorf("root-level named HTML artifact = %+v", overview)
	}
	rootIndex := artifactsByPath["index.html"]
	if rootIndex.Title != "Site landing page" || rootIndex.ArtifactURL != "/_artifacts/sre/index.html" {
		t.Errorf("root index document = %+v, want a directly addressable artifact", rootIndex)
	}
	markdown := artifactsByPath["runbooks/service-recovery.md"]
	if markdown.Title != "Service recovery" || markdown.Format != "markdown" || markdown.ID != "runbooks/service-recovery.md" {
		t.Errorf("Markdown artifact = %+v, want first H1 title and extension-preserving identity", markdown)
	}
	wantMarkdownTOC := []TOCEntry{
		{Level: 1, Text: "Service recovery", ID: "md-service-recovery"},
		{Level: 2, Text: "Request path", ID: "md-request-path"},
		{Level: 2, Text: "Recovery checks", ID: "md-recovery-checks"},
	}
	if len(markdown.TOC) != len(wantMarkdownTOC) {
		t.Fatalf("Markdown TOC = %+v, want %+v", markdown.TOC, wantMarkdownTOC)
	}
	for index := range wantMarkdownTOC {
		if markdown.TOC[index] != wantMarkdownTOC[index] {
			t.Errorf("Markdown TOC[%d] = %+v, want %+v", index, markdown.TOC[index], wantMarkdownTOC[index])
		}
	}

	unchanged, err := os.ReadFile(filepath.Join(repositoryRoot, "artifacts/incidents/checkout-latency/index.html"))
	if err != nil {
		t.Fatal(err)
	}
	if string(unchanged) != incidentHTML {
		t.Error("Build() modified the source artifact")
	}
	if _, err := os.Stat(filepath.Join(repositoryRoot, ".local/storage/_artifacts")); !os.IsNotExist(err) {
		t.Errorf("Build() should write only the index, _artifacts exists or stat failed: %v", err)
	}
}

func TestBuildCreatesZeroDocumentIndexForResourceOnlySite(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "artifacts/assets/theme.css", "body { color: navy; }\n")
	commitFixture(t, repositoryRoot, "add site resources", time.Date(2026, 2, 3, 4, 5, 6, 0, time.UTC))

	result, err := Build(context.Background(), BuildOptions{
		SiteID:    "empty",
		SiteTitle: "Empty site",
		SourceDir: "artifacts",
		OutputDir: ".local/storage",
	})
	if err != nil {
		t.Fatalf("Build() error = %v, want a valid empty artifact index", err)
	}
	if result.FilesScanned != 1 || result.ArtifactsIndexed != 0 {
		t.Fatalf("Build() = %+v, want one scanned resource and zero indexed documents", result)
	}

	indexBytes, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/storage/_indexes/empty/index.json"))
	if err != nil {
		t.Fatalf("read generated site index: %v", err)
	}
	var index struct {
		Artifacts json.RawMessage `json:"artifacts"`
	}
	if err := json.Unmarshal(indexBytes, &index); err != nil {
		t.Fatalf("decode generated site index: %v", err)
	}
	if string(index.Artifacts) != "[]" {
		t.Errorf("empty site artifacts = %s, want []", index.Artifacts)
	}

	metadataBytes, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/storage/_indexes/empty/meta.json"))
	if err != nil {
		t.Fatalf("read generated discovery metadata: %v", err)
	}
	var metadata SiteDiscoveryMetadata
	if err := json.Unmarshal(metadataBytes, &metadata); err != nil {
		t.Fatalf("decode generated discovery metadata: %v", err)
	}
	if metadata.ArtifactCount != 0 || metadata.Site != (SiteSummary{ID: "empty", Title: "Empty site"}) {
		t.Errorf("empty site discovery metadata = %+v, want site title and count zero", metadata)
	}
	if _, err := os.Stat(filepath.Join(repositoryRoot, "artifacts/assets/theme.css")); err != nil {
		t.Errorf("Build() changed or removed the source resource: %v", err)
	}
	if _, err := os.Stat(filepath.Join(repositoryRoot, ".local/storage/_artifacts")); !os.IsNotExist(err) {
		t.Errorf("Build() should write only index metadata, _artifacts exists or stat failed: %v", err)
	}
}

func TestBuildPaletteScoringProfilePacksSharedFeatures(t *testing.T) {
	artifacts := []ArtifactIndexEntry{
		{ID: "teams/latency/summary.md", Title: "Latency 日本語 𐐀guide", Path: "Teams/Latency/summary.md"},
		{ID: "teams/latency/recovery.md", Title: "Latency recovery runbook", Path: "Teams/Latency/recovery.md"},
	}
	profile := buildPaletteScoringProfile(artifacts)
	if profile.Version != 1 || profile.WordIDWidth != 16 || profile.FolderIDWidth != 16 {
		t.Fatalf("profile header = version %d, word width %d, folder width %d", profile.Version, profile.WordIDWidth, profile.FolderIDWidth)
	}
	if got, want := profile.WordOffsets, []uint32{0, 4, 8}; !reflect.DeepEqual(got, want) {
		t.Errorf("word offsets = %v, want %v", got, want)
	}
	wordIDs, ok := profile.WordIDs.([]uint16)
	if !ok {
		t.Fatalf("word IDs have type %T, want []uint16", profile.WordIDs)
	}
	if got, want := wordIDs, []uint16{0, 1, 2, 3, 0, 4, 5, 2}; !reflect.DeepEqual(got, want) {
		t.Errorf("word IDs = %v, want %v", got, want)
	}
	if got, want := profile.FolderOffsets, []uint32{0, 2, 4}; !reflect.DeepEqual(got, want) {
		t.Errorf("folder offsets = %v, want %v", got, want)
	}
	folderIDs, ok := profile.FolderIDs.([]uint16)
	if !ok {
		t.Fatalf("folder IDs have type %T, want []uint16", profile.FolderIDs)
	}
	if got, want := folderIDs, []uint16{0, 1, 0, 1}; !reflect.DeepEqual(got, want) {
		t.Errorf("folder IDs = %v, want %v", got, want)
	}
	if got := paletteProfileWords("日本語 𐐀guide Greek ΣΙΣΥΦΟΣ", cases.Lower(language.Und)); !reflect.DeepEqual(got, []string{"𐐨guide", "greek", "σισυφος"}) {
		t.Errorf("Unicode profile words = %v", got)
	}
	encoded, err := json.Marshal(profile)
	if err != nil {
		t.Fatalf("encode profile: %v", err)
	}
	var decoded struct {
		Version       int      `json:"version"`
		WordOffsets   []uint32 `json:"wordOffsets"`
		WordIDs       []uint16 `json:"wordIds"`
		WordIDWidth   int      `json:"wordIdWidth"`
		FolderOffsets []uint32 `json:"folderOffsets"`
		FolderIDs     []uint16 `json:"folderIds"`
		FolderIDWidth int      `json:"folderIdWidth"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode profile JSON: %v", err)
	}
	if decoded.Version != 1 || decoded.WordIDWidth != 16 || decoded.FolderIDWidth != 16 ||
		!reflect.DeepEqual(decoded.WordOffsets, profile.WordOffsets) ||
		!reflect.DeepEqual(decoded.WordIDs, wordIDs) ||
		!reflect.DeepEqual(decoded.FolderOffsets, profile.FolderOffsets) ||
		!reflect.DeepEqual(decoded.FolderIDs, folderIDs) {
		t.Errorf("encoded profile = %+v", decoded)
	}
}

func TestBuildPaletteScoringProfileUses32BitIDsWhenVocabularyIsLarge(t *testing.T) {
	var title strings.Builder
	for index := 0; index < 65_537; index++ {
		fmt.Fprintf(&title, " feature%05d", index)
	}
	profile := buildPaletteScoringProfile([]ArtifactIndexEntry{{Title: title.String(), Path: "summary.html"}})
	if profile.WordIDWidth != 32 {
		t.Fatalf("word ID width = %d, want 32", profile.WordIDWidth)
	}
	if _, ok := profile.WordIDs.([]uint32); !ok {
		t.Fatalf("word IDs have type %T, want []uint32", profile.WordIDs)
	}
}

func TestBuildUpdatedAtTracksUncommittedAndCommittedAssetChanges(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "artifacts/reports/latency/index.html", `<title>Latency report</title><h1 id="summary">Summary</h1>`)
	writeFixtureFile(t, repositoryRoot, "artifacts/reports/latency/appendix.html", `<title>Latency appendix</title>`)
	assetPath := filepath.Join(repositoryRoot, "artifacts/reports/latency/assets/report.css")
	writeFixtureFile(t, repositoryRoot, "artifacts/reports/latency/assets/report.css", "body { color: black; }\n")
	firstCommit := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	commitFixture(t, repositoryRoot, "add report", firstCommit)

	uncommittedTime := time.Date(2026, 3, 2, 10, 0, 0, 0, time.UTC)
	if err := os.WriteFile(assetPath, []byte("body { color: purple; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(assetPath, uncommittedTime, uncommittedTime); err != nil {
		t.Fatal(err)
	}
	index := buildAndReadIndex(t, repositoryRoot, "sre")
	for _, artifact := range index.Artifacts {
		if got := artifact.UpdatedAt; got != uncommittedTime.Format(time.RFC3339) {
			t.Errorf("uncommitted asset updatedAt for %q = %q, want %q", artifact.ID, got, uncommittedTime.Format(time.RFC3339))
		}
		if artifact.LastCommitter == nil || artifact.LastCommitter.Name != "Index Builder Test" {
			t.Errorf("uncommitted artifact lastCommitter for %q = %+v, want the last committed Git identity", artifact.ID, artifact.LastCommitter)
		}
	}

	secondCommit := time.Date(2026, 3, 3, 11, 0, 0, 0, time.UTC)
	commitFixtureWithIdentities(t, repositoryRoot, "update report stylesheet", secondCommit,
		"Stylesheet Author", "stylesheet-author@example.invalid",
		"Stylesheet Committer", "stylesheet-committer@example.invalid",
	)
	index = buildAndReadIndex(t, repositoryRoot, "sre")
	for _, artifact := range index.Artifacts {
		if got := artifact.UpdatedAt; got != secondCommit.Format(time.RFC3339) {
			t.Errorf("committed asset updatedAt for %q = %q, want %q", artifact.ID, got, secondCommit.Format(time.RFC3339))
		}
		if artifact.LastCommitter == nil || artifact.LastCommitter.Name != "Stylesheet Committer" {
			t.Errorf("asset update lastCommitter for %q = %+v, want committer of the stylesheet change", artifact.ID, artifact.LastCommitter)
		}
	}

	appendixPath := filepath.Join(repositoryRoot, "artifacts/reports/latency/appendix.html")
	if err := os.WriteFile(appendixPath, []byte(`<title>Updated latency appendix</title>`), 0o644); err != nil {
		t.Fatal(err)
	}
	thirdCommit := time.Date(2026, 3, 4, 13, 0, 0, 0, time.UTC)
	commitFixtureWithIdentities(t, repositoryRoot, "update only the appendix page", thirdCommit,
		"Appendix Author", "appendix-author@example.invalid",
		"Appendix Committer", "appendix-committer@example.invalid",
	)
	index = buildAndReadIndex(t, repositoryRoot, "sre")
	for _, artifact := range index.Artifacts {
		want := secondCommit
		wantCommitter := "Stylesheet Committer"
		if artifact.ID == "reports/latency/appendix.html" {
			want = thirdCommit
			wantCommitter = "Appendix Committer"
		}
		if got := artifact.UpdatedAt; got != want.Format(time.RFC3339) {
			t.Errorf("page-specific updatedAt for %q = %q, want %q", artifact.ID, got, want.Format(time.RFC3339))
		}
		if artifact.LastCommitter == nil || artifact.LastCommitter.Name != wantCommitter {
			t.Errorf("page-specific lastCommitter for %q = %+v, want %q", artifact.ID, artifact.LastCommitter, wantCommitter)
		}
	}
}

func TestBuildUsesFilesystemMetadataForGitIgnoredStaticOutput(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, ".gitignore", "/static-output/\n")
	commitFixture(t, repositoryRoot, "ignore generated static output", time.Date(2026, 6, 1, 9, 0, 0, 0, time.UTC))

	pagePath := filepath.Join(repositoryRoot, "static-output/reports/accessibility/index.html")
	assetPath := filepath.Join(repositoryRoot, "static-output/reports/accessibility/styles.css")
	writeFixtureFile(t, repositoryRoot, "static-output/reports/accessibility/index.html", `<title>Accessibility report</title><h1 id="summary">Summary</h1>`)
	writeFixtureFile(t, repositoryRoot, "static-output/reports/accessibility/styles.css", "body { color: navy; }\n")
	pageUpdatedAt := time.Date(2026, 6, 2, 10, 0, 0, 0, time.UTC)
	assetUpdatedAt := pageUpdatedAt.Add(time.Hour)
	if err := os.Chtimes(pagePath, pageUpdatedAt, pageUpdatedAt); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(assetPath, assetUpdatedAt, assetUpdatedAt); err != nil {
		t.Fatal(err)
	}

	if _, err := gitOutput(context.Background(), repositoryRoot, "check-ignore", "-q", "static-output/reports/accessibility/index.html"); err != nil {
		t.Fatalf("generated HTML is not ignored by Git: %v", err)
	}
	result, err := Build(context.Background(), BuildOptions{
		SiteID:    "wcag",
		SiteTitle: "WCAG",
		SourceDir: "static-output",
		OutputDir: ".local/storage",
		Now:       func() time.Time { return assetUpdatedAt.Add(time.Hour) },
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if result.ArtifactsIndexed != 1 {
		t.Fatalf("ArtifactsIndexed = %d, want 1", result.ArtifactsIndexed)
	}

	indexBytes, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/storage/_indexes/wcag/index.json"))
	if err != nil {
		t.Fatalf("read generated site index: %v", err)
	}
	var index SiteIndex
	if err := json.Unmarshal(indexBytes, &index); err != nil {
		t.Fatalf("decode generated site index: %v", err)
	}
	artifact := index.Artifacts[0]
	if artifact.UpdatedAt != assetUpdatedAt.Format(time.RFC3339) {
		t.Errorf("UpdatedAt = %q, want latest static-tree modification time %q", artifact.UpdatedAt, assetUpdatedAt.Format(time.RFC3339))
	}
	if artifact.LastCommitter != nil {
		t.Errorf("LastCommitter = %+v, want omitted for Git-ignored generated output", artifact.LastCommitter)
	}
}

func TestBuildKeepsDifferentSourceFilesAsDistinctRoutes(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "artifacts/reports.html", `<title>HTML report</title>`)
	writeFixtureFile(t, repositoryRoot, "artifacts/reports.md", "# Markdown report\n")
	writeFixtureFile(t, repositoryRoot, "artifacts/reports/index.html", `<title>Nested report</title>`)
	commitFixture(t, repositoryRoot, "add distinct reports", time.Date(2026, 3, 5, 12, 0, 0, 0, time.UTC))

	index := buildAndReadIndex(t, repositoryRoot, "sre")
	if len(index.Artifacts) != 3 {
		t.Fatalf("indexed %d documents, want 3", len(index.Artifacts))
	}
	byPath := make(map[string]ArtifactIndexEntry, len(index.Artifacts))
	for _, artifact := range index.Artifacts {
		byPath[artifact.Path] = artifact
	}
	if byPath["reports.html"].Format != "html" || byPath["reports.md"].Format != "markdown" || byPath["reports/index.html"].Format != "html" {
		t.Errorf("same-name and index documents were not independently indexed: %+v", index.Artifacts)
	}
	if byPath["reports.md"].Title != "Markdown report" {
		t.Errorf("Markdown title = %q, want first H1", byPath["reports.md"].Title)
	}

	_, err := Build(context.Background(), BuildOptions{
		SiteID:    "sre",
		SourceDir: "artifacts",
		OutputDir: ".local/storage",
	})
	if err != nil {
		t.Fatalf("Build() second call error = %v, want extension-distinct pages to coexist", err)
	}
}

func TestReadMarkdownMetadataUsesGitHubCompatibleHeadingIDs(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "headings.md")
	source := []byte(`# **Café** & 日本語
## Repeated heading
## Repeated heading
## Punctuation: beta / alpha
<h3 id="explicit-anchor">Custom HTML heading</h3>
`)
	if err := os.WriteFile(filename, source, 0o600); err != nil {
		t.Fatal(err)
	}

	metadata, err := readArtifactMetadata(filename, filepath.Base(filename))
	if err != nil {
		t.Fatalf("readArtifactMetadata() error = %v", err)
	}
	want := []TOCEntry{
		{Level: 1, Text: "Café & 日本語", ID: "md-café--日本語"},
		{Level: 2, Text: "Repeated heading", ID: "md-repeated-heading"},
		{Level: 2, Text: "Repeated heading", ID: "md-repeated-heading-1"},
		{Level: 2, Text: "Punctuation: beta / alpha", ID: "md-punctuation-beta--alpha"},
		{Level: 3, Text: "Custom HTML heading", ID: "md-explicit-anchor"},
	}
	if len(metadata.toc) != len(want) {
		t.Fatalf("TOC = %+v, want %+v", metadata.toc, want)
	}
	for index := range want {
		if metadata.toc[index] != want[index] {
			t.Errorf("TOC[%d] = %+v, want %+v", index, metadata.toc[index], want[index])
		}
	}
}

func TestMarkdownHeadingIDsMatchSharedConformanceFixture(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("testdata", "markdown-heading-id-cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Markdown string `json:"markdown"`
		Headings []struct {
			Case         string `json:"case"`
			Level        int    `json:"level"`
			RenderedText string `json:"renderedText"`
			TocText      string `json:"tocText"`
			ID           string `json:"id"`
		} `json:"headings"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}

	document, err := renderMarkdownHTMLDocument([]byte(fixture.Markdown))
	if err != nil {
		t.Fatalf("renderMarkdownHTMLDocument() error = %v", err)
	}
	type headingOutput struct {
		Level int
		Text  string
		ID    string
	}
	var gotHeadings []headingOutput
	var collect func(*html.Node)
	collect = func(node *html.Node) {
		if level := markdownHeadingRank(node); level > 0 {
			gotHeadings = append(gotHeadings, headingOutput{
				Level: level,
				Text:  markdownHeadingText(node),
				ID:    htmlAttribute(node, "id"),
			})
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			collect(child)
		}
	}
	collect(document)
	wantHeadings := make([]headingOutput, 0, len(fixture.Headings))
	for _, heading := range fixture.Headings {
		wantHeadings = append(wantHeadings, headingOutput{Level: heading.Level, Text: heading.RenderedText, ID: heading.ID})
	}
	if !reflect.DeepEqual(gotHeadings, wantHeadings) {
		t.Fatalf("rendered Markdown headings = %#v, want %#v", gotHeadings, wantHeadings)
	}

	filename := filepath.Join(t.TempDir(), "conformance.md")
	if err := os.WriteFile(filename, []byte(fixture.Markdown), 0o600); err != nil {
		t.Fatal(err)
	}
	metadata, err := readArtifactMetadata(filename, filepath.Base(filename))
	if err != nil {
		t.Fatalf("readArtifactMetadata() error = %v", err)
	}
	wantTOC := make([]TOCEntry, 0)
	for _, heading := range fixture.Headings {
		if heading.Level >= 1 && heading.Level <= 3 && heading.TocText != "" {
			wantTOC = append(wantTOC, TOCEntry{Level: heading.Level, Text: heading.TocText, ID: heading.ID})
		}
	}
	if !reflect.DeepEqual(metadata.toc, wantTOC) {
		t.Errorf("Markdown TOC = %+v, want %+v", metadata.toc, wantTOC)
	}
}

func TestReadHTMLMetadataLeavesHeadingIDsUnchanged(t *testing.T) {
	filename := filepath.Join(t.TempDir(), "report.html")
	if err := os.WriteFile(filename, []byte(`<html><body><h2 id="html-anchor">Keep this ID</h2></body></html>`), 0o600); err != nil {
		t.Fatal(err)
	}

	metadata, err := readArtifactMetadata(filename, filepath.Base(filename))
	if err != nil {
		t.Fatalf("readArtifactMetadata() error = %v", err)
	}
	want := []TOCEntry{{Level: 2, Text: "Keep this ID", ID: "html-anchor"}}
	if !reflect.DeepEqual(metadata.toc, want) {
		t.Fatalf("HTML TOC = %+v, want %+v", metadata.toc, want)
	}
}

func TestBuildRejectsInvalidSiteID(t *testing.T) {
	_, err := Build(context.Background(), BuildOptions{SiteID: "../sre", SourceDir: "."})
	if err == nil || !strings.Contains(err.Error(), "invalid site identifier") {
		t.Fatalf("Build() error = %v, want invalid-site error", err)
	}
}

func TestParseRepositoryRemote(t *testing.T) {
	tests := []struct {
		name       string
		remote     string
		repository string
		url        string
	}{
		{name: "https", remote: "https://github.com/acme/reports.git", repository: "acme/reports", url: "https://github.com/acme/reports"},
		{name: "ssh", remote: "git@github.com:acme/reports.git", repository: "acme/reports", url: "https://github.com/acme/reports"},
		{name: "enterprise", remote: "ssh://git@git.example.com/platform/reports.git", repository: "platform/reports", url: "https://git.example.com/platform/reports"},
		{name: "invalid", remote: "not a remote", repository: "", url: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotRepository, gotURL := parseRepositoryRemote(test.remote)
			if gotRepository != test.repository || gotURL != test.url {
				t.Errorf("parseRepositoryRemote(%q) = (%q, %q), want (%q, %q)", test.remote, gotRepository, gotURL, test.repository, test.url)
			}
		})
	}
}

func TestParseGitHubRepositoryRemoteRequiresCanonicalGitHubOwnerRepo(t *testing.T) {
	tests := []struct {
		name       string
		remote     string
		repository string
		url        string
	}{
		{name: "https", remote: "https://github.com/acme/reports.git", repository: "acme/reports", url: "https://github.com/acme/reports"},
		{name: "scp ssh", remote: "git@github.com:acme/reports.git", repository: "acme/reports", url: "https://github.com/acme/reports"},
		{name: "ssh url", remote: "ssh://git@github.com/acme/reports.git", repository: "acme/reports", url: "https://github.com/acme/reports"},
		{name: "non GitHub host", remote: "git@gitlab.com:acme/reports.git"},
		{name: "nested path", remote: "https://github.com/acme/platform/reports.git"},
		{name: "missing repository", remote: "https://github.com/acme"},
		{name: "invalid", remote: "not a remote"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			gotRepository, gotURL := parseGitHubRepositoryRemote(test.remote)
			if gotRepository != test.repository || gotURL != test.url {
				t.Errorf("parseGitHubRepositoryRemote(%q) = (%q, %q), want (%q, %q)", test.remote, gotRepository, gotURL, test.repository, test.url)
			}
		})
	}
}

func BenchmarkBuildIndexFiles(b *testing.B) {
	for _, fileCount := range []int{1_000, 5_000, 10_000} {
		b.Run(fmt.Sprintf("%d-files", fileCount), func(b *testing.B) {
			repositoryRoot := initializeGitRepository(b)
			restoreWorkingDirectory := chdirForTest(b, repositoryRoot)
			defer restoreWorkingDirectory()
			writeFixtureFile(b, repositoryRoot, ".gitignore", "/artifacts/\n")
			commitFixture(b, repositoryRoot, "ignore synthetic benchmark artifacts", time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC))

			artifactCount := fileCount / 20
			for artifact := 0; artifact < artifactCount; artifact++ {
				artifactPath := filepath.Join("artifacts", fmt.Sprintf("team-%02d", artifact%10), "year-2026", fmt.Sprintf("group-%02d", artifact%25), fmt.Sprintf("report-%04d", artifact))
				writeFixtureFile(b, repositoryRoot, filepath.Join(artifactPath, "index.html"), fmt.Sprintf("<title>Report %d</title><h1 id=summary>Summary %d</h1>", artifact, artifact))
				writeFixtureFile(b, repositoryRoot, filepath.Join(artifactPath, "details.html"), fmt.Sprintf("<title>Report details %d</title>", artifact))
				for asset := 1; asset < 19; asset++ {
					writeFixtureFile(b, repositoryRoot, filepath.Join(artifactPath, "assets", "data", fmt.Sprintf("file-%02d.json", asset)), fmt.Sprintf(`{"artifact":%d,"asset":%d}`, artifact, asset))
				}
			}
			sampleFixture := filepath.Join("artifacts", "team-00", "year-2026", "group-00", "report-0000", "index.html")
			if _, err := gitOutput(context.Background(), repositoryRoot, "check-ignore", "-q", filepath.ToSlash(sampleFixture)); err != nil {
				b.Fatalf("benchmark fixture %q is not ignored by Git: %v", sampleFixture, err)
			}
			if _, err := gitOutput(context.Background(), repositoryRoot, "ls-files", "--error-unmatch", filepath.ToSlash(sampleFixture)); err == nil {
				b.Fatalf("benchmark fixture %q is tracked by Git", sampleFixture)
			}

			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				_, err := Build(context.Background(), BuildOptions{
					SiteID:    "benchmark",
					SourceDir: "artifacts",
					OutputDir: ".local/storage",
					Now:       func() time.Time { return time.Date(2026, 4, 2, 0, 0, 0, 0, time.UTC) },
				})
				if err != nil {
					b.Fatal(err)
				}
			}
			b.ReportMetric(float64(fileCount), "source-files/op")
			b.ReportMetric(float64(artifactCount*2), "html-pages/op")
		})
	}
}

func BenchmarkBuildIndexGitHistoryPages(b *testing.B) {
	const updateCommitCount = 50
	for _, pageCount := range []int{500, 1_000} {
		b.Run(fmt.Sprintf("%d-html-pages", pageCount), func(b *testing.B) {
			repositoryRoot := initializeGitRepository(b)
			restoreWorkingDirectory := chdirForTest(b, repositoryRoot)
			defer restoreWorkingDirectory()
			writeFixtureFile(b, repositoryRoot, ".gitignore", "/.local/\n")

			for page := 0; page < pageCount; page++ {
				filename := filepath.Join("artifacts", fmt.Sprintf("group-%02d", page%50), fmt.Sprintf("page-%04d", page), "index.html")
				writeFixtureFile(b, repositoryRoot, filename, fmt.Sprintf("<title>Page %d</title><h1 id=summary>Summary %d</h1>", page, page))
			}
			commitFixture(b, repositoryRoot, "add synthetic HTML pages", time.Date(2026, 5, 1, 0, 0, 0, 0, time.UTC))

			for revision := 0; revision < updateCommitCount; revision++ {
				page := revision % pageCount
				filename := filepath.Join("artifacts", fmt.Sprintf("group-%02d", page%50), fmt.Sprintf("page-%04d", page), "index.html")
				writeFixtureFile(b, repositoryRoot, filename, fmt.Sprintf("<title>Page %d revision %d</title><h1 id=summary>Summary %d</h1>", page, revision+1, page))
				runGit(b, repositoryRoot, "add", "--", filename)
				committerName := fmt.Sprintf("History Committer %02d", revision%5)
				committedAt := time.Date(2026, 5, 2, 0, 0, 0, 0, time.UTC).Add(time.Duration(revision) * time.Minute)
				commitStagedFixtureWithIdentities(b, repositoryRoot, "update synthetic HTML page", committedAt,
					"History Author", "history-author@example.invalid", committerName, "history-committer@example.invalid")
			}

			b.ReportAllocs()
			b.ResetTimer()
			for iteration := 0; iteration < b.N; iteration++ {
				result, err := Build(context.Background(), BuildOptions{
					SiteID:    "history-benchmark",
					SourceDir: "artifacts",
					OutputDir: ".local/storage",
					Now:       func() time.Time { return time.Date(2026, 5, 3, 0, 0, 0, 0, time.UTC) },
				})
				if err != nil {
					b.Fatal(err)
				}
				if result.ArtifactsIndexed != pageCount {
					b.Fatalf("indexed %d HTML pages, want %d", result.ArtifactsIndexed, pageCount)
				}
			}
			b.ReportMetric(float64(pageCount), "html-pages/op")
			b.ReportMetric(float64(updateCommitCount+1), "git-commits/op")
		})
	}
}

func buildAndReadIndex(t testing.TB, repositoryRoot, siteID string) SiteIndex {
	t.Helper()
	_, err := Build(context.Background(), BuildOptions{
		SiteID:    siteID,
		SourceDir: "artifacts",
		OutputDir: ".local/storage",
		Now:       func() time.Time { return time.Date(2026, 3, 4, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	contents, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/storage/_indexes", siteID, "index.json"))
	if err != nil {
		t.Fatalf("read generated index: %v", err)
	}
	var index SiteIndex
	if err := json.Unmarshal(contents, &index); err != nil {
		t.Fatalf("decode generated index: %v", err)
	}
	return index
}

func initializeGitRepository(t testing.TB) string {
	t.Helper()
	repositoryRoot := t.TempDir()
	command := exec.Command("git", "init", "--initial-branch=main")
	command.Dir = repositoryRoot
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("initialize Git repository: %v\n%s", err, output)
	}
	return repositoryRoot
}

func chdirForTest(t testing.TB, directory string) func() {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatalf("get working directory: %v", err)
	}
	if err := os.Chdir(directory); err != nil {
		t.Fatalf("change working directory to %q: %v", directory, err)
	}
	return func() {
		if err := os.Chdir(previous); err != nil {
			t.Fatalf("restore working directory to %q: %v", previous, err)
		}
	}
}

func writeFixtureFile(t testing.TB, root, filename, contents string) {
	t.Helper()
	fullPath := filepath.Join(root, filename)
	if err := os.MkdirAll(filepath.Dir(fullPath), 0o755); err != nil {
		t.Fatalf("create fixture directory: %v", err)
	}
	if err := os.WriteFile(fullPath, []byte(contents), 0o644); err != nil {
		t.Fatalf("write fixture %q: %v", filename, err)
	}
}

func commitFixture(t testing.TB, root, message string, committedAt time.Time) {
	t.Helper()
	commitFixtureWithIdentities(t, root, message, committedAt,
		"Index Builder Test", "index-builder@example.invalid",
		"Index Builder Test", "index-builder@example.invalid",
	)
}

func commitFixtureWithIdentities(t testing.TB, root, message string, committedAt time.Time, authorName, authorEmail, committerName, committerEmail string) {
	t.Helper()
	runGit(t, root, "add", "--all")
	commitStagedFixtureWithIdentities(t, root, message, committedAt, authorName, authorEmail, committerName, committerEmail)
}

func commitStagedFixtureWithIdentities(t testing.TB, root, message string, committedAt time.Time, authorName, authorEmail, committerName, committerEmail string) {
	t.Helper()
	command := exec.Command("git", "commit", "--quiet", "-m", message)
	command.Dir = root
	date := committedAt.Format(time.RFC3339)
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME="+authorName,
		"GIT_AUTHOR_EMAIL="+authorEmail,
		"GIT_COMMITTER_NAME="+committerName,
		"GIT_COMMITTER_EMAIL="+committerEmail,
		"GIT_AUTHOR_DATE="+date,
		"GIT_COMMITTER_DATE="+date,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("commit fixture: %v\n%s", err, output)
	}
}

func runGit(t testing.TB, directory string, args ...string) {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = directory
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
}

func TestDiscoverArtifactsRejectsInvalidUTF8Path(t *testing.T) {
	sourceDir := t.TempDir()
	filename := filepath.Join(sourceDir, string([]byte{'b', 'a', 'd', '-', 0xff})+".html")
	if err := os.WriteFile(filename, []byte("<h1>Bad path</h1>"), 0o600); err != nil {
		t.Skipf("filesystem does not support invalid UTF-8 names: %v", err)
	}

	if _, _, err := discoverArtifacts(sourceDir, filepath.Join(t.TempDir(), "output")); err == nil || !strings.Contains(err.Error(), "not valid UTF-8") {
		t.Fatalf("discoverArtifacts() error = %v, want invalid UTF-8 path rejection", err)
	}
}

func TestValidateUTF8RelativePathRejectsInvalidUTF8(t *testing.T) {
	relative := string([]byte{'b', 'a', 'd', '-', 0xff, '.', 'h', 't', 'm', 'l'})
	if err := ValidateUTF8RelativePath(relative); err == nil || !strings.Contains(err.Error(), "not valid UTF-8") {
		t.Fatalf("ValidateUTF8RelativePath() error = %v, want invalid UTF-8 rejection", err)
	}
	if err := ValidateUTF8RelativePath("reports/日本語 #1.html"); err != nil {
		t.Fatalf("ValidateUTF8RelativePath() rejected a valid UTF-8 path: %v", err)
	}
}
