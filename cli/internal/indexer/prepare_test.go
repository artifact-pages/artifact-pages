package indexer

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPrepareBuildFingerprintTracksOutputInputsAndIgnoresCleanCheckoutMtime(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "content/index.html", "<title>Stable</title><h1>Stable</h1>")
	writeFixtureFile(t, repositoryRoot, "content/assets/site.css", "body { color: navy; }\n")
	commitFixture(t, repositoryRoot, "add site", time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC))
	fixedNow := time.Date(2026, 4, 5, 6, 7, 8, 0, time.UTC)
	options := BuildOptions{
		SiteID: "sre", SiteTitle: "SRE", SiteDescription: "Operational notes",
		SourceDir: "content", OutputDir: ".local/output", InputPolicy: "publisher-policy-v1",
		Now: func() time.Time { return fixedNow }, RejectSymlinks: true,
	}

	first, err := PrepareBuild(context.Background(), options)
	if err != nil {
		t.Fatalf("PrepareBuild(first) error = %v", err)
	}
	if !first.Reusable || first.InputRoot == "" || len(first.Files) != 2 {
		t.Fatalf("first prepared input = reusable %v, root %q, files %d", first.Reusable, first.InputRoot, len(first.Files))
	}
	second, err := PrepareBuild(context.Background(), options)
	if err != nil {
		t.Fatalf("PrepareBuild(second) error = %v", err)
	}
	if second.InputRoot != first.InputRoot {
		t.Fatalf("unchanged input root = %q, want %q", second.InputRoot, first.InputRoot)
	}

	// A clean tracked checkout's file mtime does not feed the emitted Git-based
	// updatedAt, so touching a resource alone must not invalidate the build root.
	future := fixedNow.Add(72 * time.Hour)
	resource := filepath.Join(repositoryRoot, "content/assets/site.css")
	if err := os.Chtimes(resource, future, future); err != nil {
		t.Fatal(err)
	}
	afterTouch, err := PrepareBuild(context.Background(), options)
	if err != nil {
		t.Fatalf("PrepareBuild(after touch) error = %v", err)
	}
	if afterTouch.InputRoot != first.InputRoot {
		t.Fatalf("clean checkout mtime changed input root from %q to %q", first.InputRoot, afterTouch.InputRoot)
	}

	changedMetadata := options
	changedMetadata.SiteDescription += " updated"
	metadataInput, err := PrepareBuild(context.Background(), changedMetadata)
	if err != nil {
		t.Fatalf("PrepareBuild(metadata) error = %v", err)
	}
	if metadataInput.InputRoot == first.InputRoot {
		t.Fatal("site description change did not change the input root")
	}
	changedPolicy := options
	changedPolicy.InputPolicy += ",http-policy-v2"
	policyInput, err := PrepareBuild(context.Background(), changedPolicy)
	if err != nil {
		t.Fatalf("PrepareBuild(policy) error = %v", err)
	}
	if policyInput.InputRoot == first.InputRoot {
		t.Fatal("publisher policy change did not change the input root")
	}
}

func TestBuildPreparedUsesExactCapturedSourceBytes(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "content/index.html", "<title>Before snapshot</title><h1>Before snapshot</h1>")
	commitFixture(t, repositoryRoot, "add site", time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC))
	prepared, err := PrepareBuild(context.Background(), BuildOptions{
		SiteID: "sre", SourceDir: "content", OutputDir: ".local/output", RejectSymlinks: true,
	})
	if err != nil {
		t.Fatalf("PrepareBuild() error = %v", err)
	}
	writeFixtureFile(t, repositoryRoot, "content/index.html", "<title>After snapshot</title><h1>After snapshot</h1>")
	if _, err := BuildPrepared(context.Background(), prepared, ".local/snapshot-build"); err != nil {
		t.Fatalf("BuildPrepared() error = %v", err)
	}
	indexBytes, err := os.ReadFile(filepath.Join(repositoryRoot, ".local/snapshot-build/_indexes/sre/index.json"))
	if err != nil {
		t.Fatal(err)
	}
	var index SiteIndex
	if err := json.Unmarshal(indexBytes, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Artifacts) != 1 || index.Artifacts[0].Title != "Before snapshot" {
		t.Fatalf("built artifact = %+v, want title from captured source snapshot", index.Artifacts)
	}
}

func TestPrepareBuildDoesNotReuseInvocationClockForDeletedGitDependency(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "content/index.html", "<title>Clock case</title><h1>Clock case</h1>")
	writeFixtureFile(t, repositoryRoot, "content/assets/site.css", "body { color: navy; }\n")
	commitFixture(t, repositoryRoot, "add site", time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC))
	if err := os.Remove(filepath.Join(repositoryRoot, "content/assets/site.css")); err != nil {
		t.Fatal(err)
	}
	prepared, err := PrepareBuild(context.Background(), BuildOptions{
		SiteID: "sre", SourceDir: "content", OutputDir: ".local/output", RejectSymlinks: true,
	})
	if err != nil {
		t.Fatalf("PrepareBuild() error = %v", err)
	}
	if prepared.Reusable {
		t.Fatal("deleted tracked dependency should disable the early build skip because Build uses invocation time")
	}
}
