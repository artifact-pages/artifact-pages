package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
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
	if !first.Reusable() || first.InputRoot() == "" || len(first.SourceFiles()) != 2 {
		t.Fatalf("first prepared input = reusable %v, root %q, files %d", first.Reusable(), first.InputRoot(), len(first.SourceFiles()))
	}
	second, err := PrepareBuild(context.Background(), options)
	if err != nil {
		t.Fatalf("PrepareBuild(second) error = %v", err)
	}
	if second.InputRoot() != first.InputRoot() {
		t.Fatalf("unchanged input root = %q, want %q", second.InputRoot(), first.InputRoot())
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
	if afterTouch.InputRoot() != first.InputRoot() {
		t.Fatalf("clean checkout mtime changed input root from %q to %q", first.InputRoot(), afterTouch.InputRoot())
	}

	changedMetadata := options
	changedMetadata.SiteDescription += " updated"
	metadataInput, err := PrepareBuild(context.Background(), changedMetadata)
	if err != nil {
		t.Fatalf("PrepareBuild(metadata) error = %v", err)
	}
	if metadataInput.InputRoot() == first.InputRoot() {
		t.Fatal("site description change did not change the input root")
	}
	changedPolicy := options
	changedPolicy.InputPolicy += ",http-policy-v2"
	policyInput, err := PrepareBuild(context.Background(), changedPolicy)
	if err != nil {
		t.Fatalf("PrepareBuild(policy) error = %v", err)
	}
	if policyInput.InputRoot() == first.InputRoot() {
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
	captured, ok := prepared.ReadSourceFile("index.html")
	if !ok {
		t.Fatal("ReadSourceFile() omitted prepared document")
	}
	captured[0] = 'x'
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
	if prepared.Reusable() {
		t.Fatal("deleted tracked dependency should disable the early build skip because Build uses invocation time")
	}
}

func TestStandaloneCaptureSkipsResourceReadsAndPrepareBuildKeepsFullSnapshot(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	document := []byte("# Snapshot proof\n\nDocument bytes are part of both captures.\n")
	resource := []byte{0x00, 0x01, 0x02, 0xfe, 0xff}
	writeFixtureFile(t, repositoryRoot, "content/index.md", string(document))
	writeFixtureFile(t, repositoryRoot, "content/assets/payload.bin", string(resource))
	commitFixture(t, repositoryRoot, "add capture proof fixture", time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC))
	options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "index-only")}
	type readCounts struct{ documents, resources, documentBytes, resourceBytes int }
	newReader := func(counts *readCounts, failOnResource bool) sourceFileReader {
		return func(filename string) ([]byte, error) {
			if strings.Contains(filepath.ToSlash(filename), "/assets/") {
				counts.resources++
				if failOnResource {
					return nil, errors.New("resource body read was attempted")
				}
				data, err := os.ReadFile(filename)
				counts.resourceBytes += len(data)
				return data, err
			}
			counts.documents++
			data, err := os.ReadFile(filename)
			counts.documentBytes += len(data)
			return data, err
		}
	}

	fullCounts := &readCounts{}
	full, err := prepareBuild(context.Background(), options, sourceCaptureMode{readFile: newReader(fullCounts, false)})
	if err != nil {
		t.Fatalf("full prepareBuild() error = %v", err)
	}
	if full.InputRoot() == "" || fullCounts.documents != 1 || fullCounts.resources != 1 || fullCounts.documentBytes != len(document) || fullCounts.resourceBytes != len(resource) {
		t.Fatalf("full capture root/read counts = %q / %+v, want root and one exact document and resource read", full.InputRoot(), fullCounts)
	}
	fullResource, ok := full.ReadSourceFile("assets/payload.bin")
	if !ok || !reflect.DeepEqual(fullResource, resource) {
		t.Fatalf("full ReadSourceFile(resource) = %v, %v; want exact bytes %v", fullResource, ok, resource)
	}

	indexOnlyCounts := &readCounts{}
	indexOnly, err := prepareBuild(context.Background(), options, sourceCaptureMode{indexOnly: true, readFile: newReader(indexOnlyCounts, true)})
	if err != nil {
		t.Fatalf("index-only prepareBuild() error = %v", err)
	}
	if indexOnly.InputRoot() != "" || indexOnlyCounts.documents != 1 || indexOnlyCounts.resources != 0 || indexOnlyCounts.documentBytes != len(document) || indexOnlyCounts.resourceBytes != 0 {
		t.Fatalf("index-only root/read counts = %q / %+v, want no root, one document read, and zero resource reads", indexOnly.InputRoot(), indexOnlyCounts)
	}
	if len(indexOnly.files) != 2 {
		t.Fatalf("index-only metadata entries = %d, want both the document and resource", len(indexOnly.files))
	}
	for _, file := range indexOnly.files {
		if file.RelativePath == "assets/payload.bin" && (file.Size != int64(len(resource)) || file.SHA256 != "" || file.bytes != nil) {
			t.Fatalf("index-only resource metadata = %+v, want size only and no hash/body", file)
		}
	}
	if _, ok := indexOnly.fileByRelative["assets/payload.bin"]; ok {
		t.Fatal("index-only document lookup retained a resource body entry")
	}
	if captured, ok := indexOnly.ReadSourceFile("index.md"); !ok || !reflect.DeepEqual(captured, document) {
		t.Fatalf("index-only captured document = %q, %v; want exact document bytes", captured, ok)
	}

	buildCounts := &readCounts{}
	result, err := buildWithReader(context.Background(), options, newReader(buildCounts, true))
	if err != nil {
		t.Fatalf("standalone buildWithReader() error = %v", err)
	}
	if result.ArtifactsIndexed != 1 || buildCounts.documents != 1 || buildCounts.resources != 0 || buildCounts.resourceBytes != 0 {
		t.Fatalf("standalone Build result/read counts = %+v / %+v, want one indexed document and zero resource reads", result, buildCounts)
	}
}

func TestStandaloneCapturePreservesUnreadableResourceFailure(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "content/index.md", "# Readability check\n")
	writeFixtureFile(t, repositoryRoot, "content/assets/blocked.bin", "not captured by standalone index build")
	commitFixture(t, repositoryRoot, "add unreadable resource fixture", time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC))
	options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "unreadable")}

	fullReader := func(filename string) ([]byte, error) {
		if filepath.Base(filename) == "blocked.bin" {
			return nil, os.ErrPermission
		}
		return os.ReadFile(filename)
	}
	if _, err := prepareBuild(context.Background(), options, sourceCaptureMode{readFile: fullReader}); err == nil || !strings.Contains(err.Error(), "read source file assets/blocked.bin") {
		t.Fatalf("full capture error = %v, want resource read failure", err)
	}

	openCalls := 0
	resourceOpener := func(filename string) (*os.File, error) {
		if filepath.Base(filename) == "blocked.bin" {
			openCalls++
			return nil, os.ErrPermission
		}
		return os.Open(filename)
	}
	if _, err := buildWithSourceHooks(context.Background(), options, nil, resourceOpener); err == nil || !strings.Contains(err.Error(), "read source file assets/blocked.bin") {
		t.Fatalf("index-only open error = %v, want resource open failure", err)
	}
	if openCalls != 1 {
		t.Fatalf("resource Open calls = %d, want one permission check", openCalls)
	}
}

func TestStandaloneAndFullBuildMatchResourceTimestampsAcrossGitStates(t *testing.T) {
	repositoryRoot := initializeGitRepository(t)
	restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
	defer restoreWorkingDirectory()

	writeFixtureFile(t, repositoryRoot, "content/reports/index.md", "# Resource timestamp states\n")
	writeFixtureFile(t, repositoryRoot, "content/reports/assets/tracked.css", "body { color: black; }\n")
	commitTime := time.Date(2026, 2, 1, 9, 0, 0, 0, time.UTC)
	commitFixture(t, repositoryRoot, "add timestamp fixture", commitTime)
	deletedAt := time.Date(2026, 8, 1, 9, 0, 0, 0, time.UTC)
	options := BuildOptions{SiteID: "sre", SourceDir: "content", Now: func() time.Time { return deletedAt }}
	resourcePath := filepath.Join(repositoryRoot, "content", "reports", "assets", "tracked.css")
	assertEquivalent := func(state string, want time.Time) {
		t.Helper()
		fullOutput := filepath.Join(t.TempDir(), "full")
		standaloneOutput := filepath.Join(t.TempDir(), "standalone")
		fullOptions := options
		fullOptions.OutputDir = fullOutput
		prepared, err := PrepareBuild(context.Background(), fullOptions)
		if err != nil {
			t.Fatalf("PrepareBuild(%s) error = %v", state, err)
		}
		if prepared.InputRoot() == "" {
			t.Fatalf("PrepareBuild(%s) returned an empty publisher input root", state)
		}
		if _, err := BuildPrepared(context.Background(), prepared, fullOutput); err != nil {
			t.Fatalf("BuildPrepared(%s) error = %v", state, err)
		}
		standaloneOptions := options
		standaloneOptions.OutputDir = standaloneOutput
		if _, err := Build(context.Background(), standaloneOptions); err != nil {
			t.Fatalf("Build(%s) error = %v", state, err)
		}
		fullFiles := readBuildOutputFiles(t, fullOutput)
		standaloneFiles := readBuildOutputFiles(t, standaloneOutput)
		if !reflect.DeepEqual(standaloneFiles, fullFiles) {
			t.Fatalf("Build(%s) output differs from full prepared output", state)
		}
		index := readBuildSiteIndex(t, standaloneOutput, options.SiteID)
		if len(index.Artifacts) != 1 || index.Artifacts[0].UpdatedAt != want.Format(time.RFC3339) {
			t.Fatalf("Build(%s) index artifact = %+v, want updatedAt %q", state, index.Artifacts, want.Format(time.RFC3339))
		}
	}
	assertEquivalent("committed", commitTime)

	stagedAt := time.Date(2026, 3, 1, 10, 0, 0, 0, time.UTC)
	if err := os.WriteFile(resourcePath, []byte("body { color: purple; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(resourcePath, stagedAt, stagedAt); err != nil {
		t.Fatal(err)
	}
	runGit(t, repositoryRoot, "add", "content/reports/assets/tracked.css")
	assertEquivalent("staged", stagedAt)

	unstagedAt := time.Date(2026, 4, 1, 10, 0, 0, 0, time.UTC)
	if err := os.WriteFile(resourcePath, []byte("body { color: orange; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(resourcePath, unstagedAt, unstagedAt); err != nil {
		t.Fatal(err)
	}
	assertEquivalent("staged and unstaged", unstagedAt)

	untrackedAt := time.Date(2026, 5, 1, 10, 0, 0, 0, time.UTC)
	untrackedPath := "content/reports/assets/untracked.svg"
	writeFixtureFile(t, repositoryRoot, untrackedPath, "<svg></svg>\n")
	if err := os.Chtimes(filepath.Join(repositoryRoot, untrackedPath), untrackedAt, untrackedAt); err != nil {
		t.Fatal(err)
	}
	assertEquivalent("untracked resource", untrackedAt)

	if err := os.Remove(resourcePath); err != nil {
		t.Fatal(err)
	}
	assertEquivalent("deleted tracked resource", deletedAt)
}

func TestStandaloneCapturePreservesSymlinkAndUnsupportedEntryFailures(t *testing.T) {
	t.Run("regular resource symlink", func(t *testing.T) {
		repositoryRoot := initializeGitRepository(t)
		restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
		defer restoreWorkingDirectory()
		writeFixtureFile(t, repositoryRoot, "content/index.md", "# Symlink check\n")
		writeFixtureFile(t, repositoryRoot, "external.bin", "linked resource bytes")
		if err := os.MkdirAll(filepath.Join(repositoryRoot, "content", "assets"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(repositoryRoot, "external.bin"), filepath.Join(repositoryRoot, "content", "assets", "linked.bin")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		commitFixture(t, repositoryRoot, "add resource symlink", time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC))
		options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "symlink")}
		prepared, err := PrepareBuild(context.Background(), options)
		if err != nil {
			t.Fatalf("PrepareBuild(resource symlink) error = %v", err)
		}
		if got, ok := prepared.ReadSourceFile("assets/linked.bin"); !ok || string(got) != "linked resource bytes" {
			t.Fatalf("full symlink snapshot = %q, %v; want target bytes", got, ok)
		}
		if _, err := Build(context.Background(), options); err != nil {
			t.Fatalf("Build(resource symlink) error = %v, want success", err)
		}
		options.RejectSymlinks = true
		if _, err := PrepareBuild(context.Background(), options); err == nil || !strings.Contains(err.Error(), "symbolic links") {
			t.Fatalf("PrepareBuild(RejectSymlinks) error = %v, want symlink rejection", err)
		}
		if _, err := Build(context.Background(), options); err == nil || !strings.Contains(err.Error(), "symbolic links") {
			t.Fatalf("Build(RejectSymlinks) error = %v, want symlink rejection", err)
		}
	})

	t.Run("full snapshot preserves virtual resource bytes when stat size differs", func(t *testing.T) {
		repositoryRoot := initializeGitRepository(t)
		restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
		defer restoreWorkingDirectory()
		writeFixtureFile(t, repositoryRoot, "content/index.md", "# Virtual resource target\n")
		writeFixtureFile(t, repositoryRoot, "external.bin", "short target")
		if err := os.MkdirAll(filepath.Join(repositoryRoot, "content", "assets"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(repositoryRoot, "external.bin"), filepath.Join(repositoryRoot, "content", "assets", "virtual.bin")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		commitFixture(t, repositoryRoot, "add virtual-size resource symlink", time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC))
		options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "virtual-resource")}
		virtualBytes := []byte("bytes returned by a virtual file whose length differs from stat.Size()")
		reader := func(filename string) ([]byte, error) {
			if filepath.Base(filename) == "virtual.bin" {
				return append([]byte(nil), virtualBytes...), nil
			}
			return os.ReadFile(filename)
		}
		prepared, err := prepareBuild(context.Background(), options, sourceCaptureMode{readFile: reader})
		if err != nil {
			t.Fatalf("full capture(virtual-size resource symlink) error = %v", err)
		}
		if captured, ok := prepared.ReadSourceFile("assets/virtual.bin"); !ok || !reflect.DeepEqual(captured, virtualBytes) {
			t.Fatalf("captured virtual resource = %v, %v; want exact bytes returned by reader", captured, ok)
		}
	})

	t.Run("broken resource symlink", func(t *testing.T) {
		repositoryRoot := initializeGitRepository(t)
		restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
		defer restoreWorkingDirectory()
		writeFixtureFile(t, repositoryRoot, "content/index.md", "# Broken link\n")
		if err := os.MkdirAll(filepath.Join(repositoryRoot, "content", "assets"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(repositoryRoot, "missing.bin"), filepath.Join(repositoryRoot, "content", "assets", "broken.bin")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "broken")}
		if _, err := PrepareBuild(context.Background(), options); err == nil {
			t.Fatal("PrepareBuild(broken resource symlink) succeeded, want error")
		}
		if _, err := Build(context.Background(), options); err == nil {
			t.Fatal("Build(broken resource symlink) succeeded, want error")
		}
	})

	t.Run("non-file resource symlink", func(t *testing.T) {
		repositoryRoot := initializeGitRepository(t)
		restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
		defer restoreWorkingDirectory()
		writeFixtureFile(t, repositoryRoot, "content/index.md", "# Non-file link\n")
		targetDirectory := filepath.Join(repositoryRoot, "target-directory")
		if err := os.Mkdir(targetDirectory, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(repositoryRoot, "content", "assets"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(targetDirectory, filepath.Join(repositoryRoot, "content", "assets", "directory.bin")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "non-file")}
		if _, err := PrepareBuild(context.Background(), options); err == nil || !strings.Contains(err.Error(), "unsupported filesystem entry") {
			t.Fatalf("PrepareBuild(directory symlink) error = %v, want unsupported-entry failure", err)
		}
		if _, err := Build(context.Background(), options); err == nil || !strings.Contains(err.Error(), "unsupported filesystem entry") {
			t.Fatalf("Build(directory symlink) error = %v, want unsupported-entry failure", err)
		}
	})

	t.Run("document symlink", func(t *testing.T) {
		repositoryRoot := initializeGitRepository(t)
		restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
		defer restoreWorkingDirectory()
		writeFixtureFile(t, repositoryRoot, "content/original.md", "# Original\n")
		if err := os.Symlink(filepath.Join(repositoryRoot, "content", "original.md"), filepath.Join(repositoryRoot, "content", "linked.md")); err != nil {
			t.Skipf("symlinks unavailable: %v", err)
		}
		options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "document-link")}
		if _, err := PrepareBuild(context.Background(), options); err == nil || !strings.Contains(err.Error(), "artifact entrypoint") {
			t.Fatalf("PrepareBuild(document symlink) error = %v, want artifact symlink rejection", err)
		}
		if _, err := Build(context.Background(), options); err == nil || !strings.Contains(err.Error(), "artifact entrypoint") {
			t.Fatalf("Build(document symlink) error = %v, want artifact symlink rejection", err)
		}
	})

	t.Run("unsupported source entry", func(t *testing.T) {
		repositoryRoot := initializeGitRepository(t)
		restoreWorkingDirectory := chdirForTest(t, repositoryRoot)
		defer restoreWorkingDirectory()
		writeFixtureFile(t, repositoryRoot, "content/index.md", "# Unsupported entry\n")
		resourceDirectory := filepath.Join(repositoryRoot, "content", "assets")
		if err := os.MkdirAll(resourceDirectory, 0o755); err != nil {
			t.Fatal(err)
		}
		fifoPath := filepath.Join(resourceDirectory, "unsupported.pipe")
		if err := exec.Command("mkfifo", fifoPath).Run(); err != nil {
			t.Skipf("mkfifo unavailable: %v", err)
		}
		options := BuildOptions{SiteID: "sre", SourceDir: "content", OutputDir: filepath.Join(repositoryRoot, ".local", "unsupported")}
		if _, err := PrepareBuild(context.Background(), options); err == nil || !strings.Contains(err.Error(), "unsupported filesystem entry") {
			t.Fatalf("PrepareBuild(unsupported entry) error = %v, want unsupported-entry failure", err)
		}
		if _, err := Build(context.Background(), options); err == nil || !strings.Contains(err.Error(), "unsupported filesystem entry") {
			t.Fatalf("Build(unsupported entry) error = %v, want unsupported-entry failure", err)
		}
	})
}

func readBuildOutputFiles(t testing.TB, root string) map[string][]byte {
	t.Helper()
	files := make(map[string][]byte)
	err := filepath.WalkDir(root, func(filename string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, filename)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(filename)
		if err != nil {
			return err
		}
		files[filepath.ToSlash(relative)] = data
		return nil
	})
	if err != nil {
		t.Fatalf("read build output files under %q: %v", root, err)
	}
	return files
}

func readBuildSiteIndex(t testing.TB, output, siteID string) SiteIndex {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(output, "_indexes", siteID, "index.json"))
	if err != nil {
		t.Fatalf("read generated site index: %v", err)
	}
	var index SiteIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatalf("decode generated site index: %v", err)
	}
	return index
}
