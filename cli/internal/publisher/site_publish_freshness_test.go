package publisher

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestPublishSiteContentFreshnessAdvancesAndNoOpPreservesMetadata(t *testing.T) {
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	writePublisherFixture(t, root, "docs/artifacts/report.html", []byte("<title>Report</title><h1>Report</h1><p>Initial body.</p>"))
	if err := runPublisherGitAt(root, "add", "docs/artifacts/report.html"); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGitAt(root, "commit", "--quiet", "-m", "add initial report body"); err != nil {
		t.Fatal(err)
	}

	backend := newSiteReconcileBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	initialResult, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || initialResult.Outcome != "synced" {
		t.Fatalf("initial PublishSite() = %+v, err=%v; want synced", initialResult, err)
	}
	initialBytes := readPublishedMetadataBytes(t, backend)
	initialMetadata := decodePublishedFreshnessMetadata(t, initialBytes)
	if initialMetadata.ArtifactCount != 1 {
		t.Fatalf("initial artifactCount = %d, want 1", initialMetadata.ArtifactCount)
	}

	changedAt := time.Now().UTC().Add(time.Minute).Truncate(time.Second)
	writePublisherFixture(t, root, "docs/artifacts/report.html", []byte("<title>Report</title><h1>Report</h1><p>Changed body only.</p>"))
	commitPublisherFileAt(t, root, "docs/artifacts/report.html", "change report body", changedAt)
	initialGeneratedAt := mustParseRFC3339(t, initialMetadata.GeneratedAt)
	if untilNextGeneratedSecond := time.Until(initialGeneratedAt.Add(time.Second)); untilNextGeneratedSecond > 0 {
		time.Sleep(untilNextGeneratedSecond + 20*time.Millisecond)
	}

	changedResult, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || changedResult.Outcome != "synced" {
		t.Fatalf("body-only PublishSite() = %+v, err=%v; want synced", changedResult, err)
	}
	changedBytes := readPublishedMetadataBytes(t, backend)
	changedMetadata := decodePublishedFreshnessMetadata(t, changedBytes)
	if changedMetadata.ArtifactCount != initialMetadata.ArtifactCount {
		t.Errorf("body-only artifactCount = %d, want unchanged count %d", changedMetadata.ArtifactCount, initialMetadata.ArtifactCount)
	}
	changedGeneratedAt := mustParseRFC3339(t, changedMetadata.GeneratedAt)
	if !changedGeneratedAt.After(initialGeneratedAt) {
		t.Errorf("body-only generatedAt = %q, want a time after %q", changedMetadata.GeneratedAt, initialMetadata.GeneratedAt)
	}
	initialContentUpdatedAt := mustParseRFC3339(t, initialMetadata.ContentUpdatedAt)
	changedContentUpdatedAt := mustParseRFC3339(t, changedMetadata.ContentUpdatedAt)
	if !changedContentUpdatedAt.After(initialContentUpdatedAt) {
		t.Errorf("body-only contentUpdatedAt = %q, want a time after %q", changedMetadata.ContentUpdatedAt, initialMetadata.ContentUpdatedAt)
	}
	if !changedContentUpdatedAt.Equal(changedAt) {
		t.Errorf("body-only contentUpdatedAt = %q, want commit time %q", changedMetadata.ContentUpdatedAt, changedAt.Format(time.RFC3339))
	}

	noOpResult, err := PublishSite(context.Background(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"})
	if err != nil || noOpResult.Outcome != "no-op" {
		t.Fatalf("unchanged PublishSite() = %+v, err=%v; want no-op", noOpResult, err)
	}
	noOpBytes := readPublishedMetadataBytes(t, backend)
	if string(noOpBytes) != string(changedBytes) {
		t.Errorf("no-op metadata bytes changed:\n got %s\nwant %s", noOpBytes, changedBytes)
	}
}

type publishedFreshnessMetadata struct {
	GeneratedAt      string `json:"generatedAt"`
	ContentUpdatedAt string `json:"contentUpdatedAt"`
	ArtifactCount    int    `json:"artifactCount"`
}

func readPublishedMetadataBytes(t *testing.T, backend *siteReconcileBackend) []byte {
	t.Helper()
	object, _, err := backend.lockMemoryBackend.GetObject(context.Background(), "_indexes/sre/meta.json")
	if err != nil {
		t.Fatalf("read published metadata: %v", err)
	}
	return append([]byte(nil), object.Bytes...)
}

func decodePublishedFreshnessMetadata(t *testing.T, data []byte) publishedFreshnessMetadata {
	t.Helper()
	var metadata publishedFreshnessMetadata
	if err := json.Unmarshal(data, &metadata); err != nil {
		t.Fatalf("decode published metadata: %v", err)
	}
	if metadata.GeneratedAt == "" || metadata.ContentUpdatedAt == "" {
		t.Fatalf("published freshness metadata = %+v, want both timestamps", metadata)
	}
	return metadata
}

func mustParseRFC3339(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("parse timestamp %q: %v", value, err)
	}
	return parsed
}

func commitPublisherFileAt(t *testing.T, root, file, message string, committedAt time.Time) {
	t.Helper()
	if err := runPublisherGitAt(root, "add", file); err != nil {
		t.Fatal(err)
	}
	date := committedAt.Format(time.RFC3339)
	command := exec.Command("git", "commit", "--quiet", "-m", message)
	command.Dir = root
	command.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git commit %q: %v: %s", message, err, output)
	}
}
