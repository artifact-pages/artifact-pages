//go:build td10audit

package preview

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	td10PageCount      = 100
	td10UniqueCSSBytes = 64 * 1024
	td10PreviewCache   = "public, max-age=0, s-maxage=300, must-revalidate"
)

func TestTD10BlobReuseAudit(t *testing.T) {
	for _, name := range []string{
		"noop",
		"single-document",
		"shared-100-css-svg",
		"unique-100-css-large",
		"unused-resource-delete",
		"referenced-resource-delete",
		"resource-rename-unchanged-references",
		"resource-rename-updated-reference",
	} {
		t.Run(name, func(t *testing.T) {
			repo, options, baseSHA, headSHA := td10Fixture(t, name)
			options.RepositoryDir = repo
			options.Now = func() time.Time { return time.Date(2026, 1, 3, 0, 0, 0, 0, time.UTC) }

			baseline := td10RunBuild(t, options, false)
			candidate := td10RunBuild(t, options, true)

			td10CompareBuilds(t, name, baseline, candidate)
			td10AssertExpected(t, name, candidate.identity, candidate.errorText)
			if candidate.audit.NonCatFileProcesses != baseline.audit.NonCatFileProcesses {
				t.Fatalf("non-cat-file Git process counts changed: before=%d candidate=%d", baseline.audit.NonCatFileProcesses, candidate.audit.NonCatFileProcesses)
			}
			if candidate.audit.CatFileStdoutBytes > baseline.audit.CatFileStdoutBytes || candidate.audit.CatFileProcesses > baseline.audit.CatFileProcesses {
				t.Fatalf("candidate increased cat-file work: before=%#v candidate=%#v", baseline.audit, candidate.audit)
			}
			if avoided := baseline.audit.CatFileStdoutBytes - candidate.audit.CatFileStdoutBytes; avoided != candidate.stats.GitBodyBytesAvoided {
				t.Fatalf("measured cat-file stdout reduction=%d bytes, candidate reuse counter=%d", avoided, candidate.stats.GitBodyBytesAvoided)
			}
			if candidate.stats.CacheBytesAfterAssembly > candidate.stats.CacheBytesAtAssemblyStart {
				t.Fatalf("cache grew during assembly: start=%d after=%d", candidate.stats.CacheBytesAtAssemblyStart, candidate.stats.CacheBytesAfterAssembly)
			}
			if name == "unique-100-css-large" {
				if candidate.stats.MaxReusableCacheBytes != candidate.stats.SelectedFileBytes || candidate.stats.CacheBytesAtAssemblyStart != candidate.stats.SelectedFileBytes {
					t.Fatalf("large unique-resource scan retained unselected candidate bodies: cache peak=%d assembly=%d selected output=%d", candidate.stats.MaxReusableCacheBytes, candidate.stats.CacheBytesAtAssemblyStart, candidate.stats.SelectedFileBytes)
				}
				if candidate.stats.MaxExplicitBlobBufferBytes > candidate.stats.SelectedFileBytes+td10UniqueCSSBytes+1024 {
					t.Fatalf("explicit scan buffers exceeded selected output plus one candidate closure: max=%d selected=%d", candidate.stats.MaxExplicitBlobBufferBytes, candidate.stats.SelectedFileBytes)
				}
			}
			if name == "unused-resource-delete" && (candidate.stats.MaxReusableCacheBytes != 0 || candidate.stats.CacheBytesAtAssemblyStart != 0) {
				t.Fatalf("unused-resource deletion retained irrelevant scan blobs: %#v", candidate.stats)
			}

			t.Logf("fixture=deterministic_git base_sha=%s head_sha=%s", baseSHA, headSHA)
			t.Logf("baseline git_processes=%d cat_file_processes=%d cat_file_stdout_bytes=%d measured_ms=%.3f", baseline.audit.GitProcesses, baseline.audit.CatFileProcesses, baseline.audit.CatFileStdoutBytes, float64(baseline.elapsed.Nanoseconds())/1e6)
			t.Logf("candidate git_processes=%d cat_file_processes=%d cat_file_stdout_bytes=%d git_body_bytes_avoided=%d measured_ms=%.3f", candidate.audit.GitProcesses, candidate.audit.CatFileProcesses, candidate.audit.CatFileStdoutBytes, candidate.stats.GitBodyBytesAvoided, float64(candidate.elapsed.Nanoseconds())/1e6)
			t.Logf("candidate cache_bytes_at_assembly_start=%d cache_bytes_after_assembly=%d max_reusable_cache_bytes=%d max_explicit_blob_buffer_bytes=%d selected_files_bytes=%d", candidate.stats.CacheBytesAtAssemblyStart, candidate.stats.CacheBytesAfterAssembly, candidate.stats.MaxReusableCacheBytes, candidate.stats.MaxExplicitBlobBufferBytes, candidate.stats.SelectedFileBytes)
			t.Logf("outcome=%s documents=%d files=%d file_bytes=%d preview_http_metadata_fingerprint=%s baseline_post_gc_live_heap_bytes=%d candidate_post_gc_live_heap_bytes=%d", candidate.identity.Outcome, len(candidate.identity.Documents), len(candidate.identity.FilePaths), candidate.identity.FileBytes, candidate.identity.PreviewHTTPMetadataFingerprint, baseline.postGCLiveHeapBytes, candidate.postGCLiveHeapBytes)
		})
	}
}

func TestTD10BlobReusePreservesPathIsolationAndDoesNotCacheFailures(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/page.html", "<html><title>base</title></html>\n")
	writeTestFile(t, repo, "site/assets/first.css", "body{color:teal}\n")
	writeTestFile(t, repo, "site/assets/second.css", "body{color:teal}\n")
	td10Git(t, repo, "add", ".")
	baseSHA := td10Commit(t, repo, "isolation-base", "2026-01-01T00:00:00Z")
	td10Git(t, repo, "checkout", "-b", "preview")
	writeTestFile(t, repo, "site/page.html", "<html><title>changed</title></html>\n")
	td10Git(t, repo, "add", ".")
	headSHA := td10Commit(t, repo, "isolation-head", "2026-01-02T00:00:00Z")
	options := BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: baseSHA, HeadRef: headSHA,
		ExplicitResources: []string{"assets/first.css", "assets/second.css"},
	}
	first, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("body{color:teal}\n")
	if !bytes.Equal(first.Files["assets/first.css"], want) || !bytes.Equal(first.Files["assets/second.css"], want) {
		t.Fatalf("initial resource bytes = %q and %q", first.Files["assets/first.css"], first.Files["assets/second.css"])
	}
	first.Files["assets/first.css"][0] = 'X'
	if !bytes.Equal(first.Files["assets/second.css"], want) {
		t.Fatalf("same-SHA result paths alias mutable bytes: second=%q", first.Files["assets/second.css"])
	}
	second, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(second.Files["assets/first.css"], want) || !bytes.Equal(second.Files["assets/second.css"], want) {
		t.Fatalf("a prior returned result affected the next build: first=%q second=%q", second.Files["assets/first.css"], second.Files["assets/second.css"])
	}

	blobSHA := td10Git(t, repo, "rev-parse", headSHA+":site/assets/first.css")
	entry := treeEntry{Mode: "100644", Type: "blob", SHA: blobSHA, Path: "assets/first.css"}
	reuse := &buildBlobReuse{bodies: make(map[string][]byte), stats: &blobReuseStats{}}
	selected := make(map[string][]byte)
	logPath := filepath.Join(t.TempDir(), "failure-audit.log")
	restore := td10InstallGitAudit(t, logPath, blobSHA, filepath.Join(t.TempDir(), "failed-once"))
	if _, err := readTreeBlobForBundle(context.Background(), repo, entry, reuse, selected); err == nil {
		restore()
		t.Fatal("first transient blob read unexpectedly succeeded")
	}
	if len(reuse.bodies) != 0 || len(selected) != 0 || reuse.stats.GitBodyBytesAvoided != 0 {
		restore()
		t.Fatalf("failed read affected cache: cache=%v selected=%v stats=%#v", reuse.bodies, selected, reuse.stats)
	}
	body, err := readTreeBlobForBundle(context.Background(), repo, entry, reuse, selected)
	restore()
	if err != nil || !bytes.Equal(body, want) || len(reuse.bodies) != 0 {
		t.Fatalf("retry after failed read = %q, %v; cache=%v", body, err, reuse.bodies)
	}
	audit := td10ReadAudit(t, logPath)
	if audit.CatFileProcesses != 2 || audit.CatFileStdoutBytes != int64(len(want)) {
		t.Fatalf("failed reads were cached or not retried: audit=%#v", audit)
	}
	t.Logf("failure_retry cat_file_processes=%d cat_file_stdout_bytes=%d first_error_bytes=0; failed body was not cached", audit.CatFileProcesses, audit.CatFileStdoutBytes)
}

func TestTD10BlobCacheValidatesModeBeforeSameSHALookup(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/doc-000.html", td10Page(0, "a-bytes.css"))
	writeTestFile(t, repo, "site/docs/doc-001.html", td10Page(1, "z-link.css"))
	writeTestFile(t, repo, "site/assets/a-bytes.css", "old-content")
	writeTestFile(t, repo, "site/assets/target.css", "body{color:green}\n")
	linkPath := filepath.Join(repo, "site", "assets", "z-link.css")
	if err := os.Symlink("target.css", linkPath); err != nil {
		t.Fatal(err)
	}
	td10Git(t, repo, "add", ".")
	baseSHA := td10Commit(t, repo, "symlink-base", "2026-01-01T00:00:00Z")
	td10Git(t, repo, "checkout", "-b", "preview")
	writeTestFile(t, repo, "site/assets/a-bytes.css", "target.css")
	writeTestFile(t, repo, "site/docs/doc-000.html", "<html><head><link rel=\"stylesheet\" href=\"../assets/a-bytes.css\"><link rel=\"stylesheet\" href=\"../assets/z-link.css\"></head></html>\n")
	td10Git(t, repo, "add", "-A")
	headSHA := td10Commit(t, repo, "symlink-head", "2026-01-02T00:00:00Z")
	regularSHA := td10Git(t, repo, "rev-parse", headSHA+":site/assets/a-bytes.css")
	linkSHA := td10Git(t, repo, "rev-parse", headSHA+":site/assets/z-link.css")
	if regularSHA != linkSHA {
		t.Fatalf("fixture blobs should share one SHA: regular=%s symlink=%s", regularSHA, linkSHA)
	}

	tree, err := listTree(context.Background(), repo, headSHA, "site")
	if err != nil {
		t.Fatal(err)
	}
	reuse := &buildBlobReuse{bodies: map[string][]byte{regularSHA: []byte("target.css")}, stats: &blobReuseStats{}}
	affected, err := findDependencyDocuments(context.Background(), repo, tree, []string{"assets/a-bytes.css"}, nil, map[string]Document{}, reuse)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := affected["docs/doc-000.html"]; !ok {
		t.Fatalf("regular same-SHA resource did not select its document: %#v", affected)
	}
	if _, ok := affected["docs/doc-001.html"]; ok {
		t.Fatalf("symlink with cached regular blob was treated as a changed regular resource: %#v", affected)
	}
	if reuse.stats.GitBodyBytesAvoided != int64(len("target.css")) {
		t.Fatalf("symlink bypassed the type check before SHA reuse: avoided bytes=%d, want only regular blob's %d", reuse.stats.GitBodyBytesAvoided, len("target.css"))
	}

	options := td10Options(baseSHA, headSHA)
	options.RepositoryDir = repo
	result, err := BuildFromGit(context.Background(), options)
	if err == nil || !strings.Contains(err.Error(), "not a regular file (mode 120000)") {
		t.Fatalf("same-SHA symlink was accepted during bundle assembly: result=%#v err=%v", result, err)
	}
}

type td10BuildMeasurement struct {
	identity            td10ResultIdentity
	errorText           string
	audit               td10GitAudit
	stats               blobReuseStats
	elapsed             time.Duration
	postGCLiveHeapBytes uint64
}

type td10ResultIdentity struct {
	Outcome                        Outcome
	GroupSHA256                    string
	ManifestSHA256                 string
	FilesSHA256                    string
	PreviewHTTPMetadataFingerprint string
	FilePaths                      []string
	FileBytes                      int64
	Documents                      []td10DocumentIdentity
}

type td10DocumentIdentity struct {
	Path             string
	Reason           string
	ChangedResources []string
}

type td10GitAudit struct {
	GitProcesses        int
	NonCatFileProcesses int
	CatFileProcesses    int
	CatFileStdoutBytes  int64
}

func td10RunBuild(t *testing.T, options BuildOptions, reuse bool) td10BuildMeasurement {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "git-audit.log")
	runtime.GC()
	var stats blobReuseStats
	restore := td10InstallGitAudit(t, logPath, "", "")
	started := time.Now()
	result, buildErr := buildFromGit(context.Background(), options, reuse, &stats)
	elapsed := time.Since(started)
	restore()
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	identity := resultIdentity(result)
	var errorText string
	if buildErr != nil {
		errorText = buildErr.Error()
	}
	runtime.KeepAlive(result)
	return td10BuildMeasurement{
		identity: identity, errorText: errorText, audit: td10ReadAudit(t, logPath),
		stats: stats, elapsed: elapsed, postGCLiveHeapBytes: after.HeapAlloc,
	}
}

func td10WriteGitShim(t *testing.T) (string, string) {
	t.Helper()
	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	shimDir := t.TempDir()
	shim := `#!/bin/sh
if [ "$1" = "cat-file" ] && [ "$2" = "blob" ]; then
  if [ -n "${TD10_FAIL_SHA:-}" ] && [ "$3" = "$TD10_FAIL_SHA" ] && [ -n "${TD10_FAIL_MARK:-}" ] && [ ! -e "$TD10_FAIL_MARK" ]; then
    : > "$TD10_FAIL_MARK"
    printf 'cat-file-error\t%s\t0\n' "$3" >> "$TD10_GIT_LOG"
    printf 'injected one-shot cat-file failure\n' >&2
    exit 1
  fi
  temp="${TD10_GIT_LOG}.$$.body"
  "$TD10_REAL_GIT" "$@" > "$temp"
  status=$?
  if [ "$status" -eq 0 ]; then
    size=$(wc -c < "$temp" | tr -d '[:space:]')
    printf 'cat-file\t%s\t%s\n' "$3" "$size" >> "$TD10_GIT_LOG"
    cat "$temp"
  else
    printf 'cat-file-error\t%s\t0\n' "$3" >> "$TD10_GIT_LOG"
    cat "$temp" >&2
  fi
  rm -f "$temp"
  exit "$status"
fi
printf 'git\t%s\n' "$*" >> "$TD10_GIT_LOG"
exec "$TD10_REAL_GIT" "$@"
`
	shimPath := filepath.Join(shimDir, "git")
	if err := os.WriteFile(shimPath, []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	return shimPath, realGit
}

func td10InstallGitAudit(t *testing.T, logPath, failSHA, failMarker string) func() {
	t.Helper()
	shimPath, realGit := td10WriteGitShim(t)
	shimDir := filepath.Dir(shimPath)
	oldPath, oldReal := os.Getenv("PATH"), os.Getenv("TD10_REAL_GIT")
	oldLog, oldFailSHA, oldFailMark := os.Getenv("TD10_GIT_LOG"), os.Getenv("TD10_FAIL_SHA"), os.Getenv("TD10_FAIL_MARK")
	if err := os.Setenv("PATH", shimDir+string(os.PathListSeparator)+oldPath); err != nil {
		t.Fatal(err)
	}
	_ = os.Setenv("TD10_REAL_GIT", realGit)
	_ = os.Setenv("TD10_GIT_LOG", logPath)
	_ = os.Setenv("TD10_FAIL_SHA", failSHA)
	_ = os.Setenv("TD10_FAIL_MARK", failMarker)
	return func() {
		_ = os.Setenv("PATH", oldPath)
		_ = os.Setenv("TD10_REAL_GIT", oldReal)
		_ = os.Setenv("TD10_GIT_LOG", oldLog)
		_ = os.Setenv("TD10_FAIL_SHA", oldFailSHA)
		_ = os.Setenv("TD10_FAIL_MARK", oldFailMark)
	}
}

func td10ReadAudit(t *testing.T, logPath string) td10GitAudit {
	t.Helper()
	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	var audit td10GitAudit
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		audit.GitProcesses++
		switch fields[0] {
		case "git":
			audit.NonCatFileProcesses++
		case "cat-file":
			audit.CatFileProcesses++
			if len(fields) != 3 {
				t.Fatalf("malformed cat-file audit row %q", line)
			}
			bodyBytes, err := strconv.ParseInt(fields[2], 10, 64)
			if err != nil {
				t.Fatalf("invalid cat-file stdout byte count in %q: %v", line, err)
			}
			audit.CatFileStdoutBytes += bodyBytes
		case "cat-file-error":
			audit.CatFileProcesses++
		default:
			t.Fatalf("unknown Git audit row %q", line)
		}
	}
	return audit
}

func td10Fixture(t *testing.T, name string) (string, BuildOptions, string, string) {
	t.Helper()
	repo := t.TempDir()
	td10Git(t, repo, "init", "-b", "main")
	td10Git(t, repo, "config", "user.name", "TD10 Audit")
	td10Git(t, repo, "config", "user.email", "td10@example.test")

	for index := 0; index < td10PageCount; index++ {
		resource := ""
		switch name {
		case "shared-100-css-svg":
			resource = "shared.css"
		case "unique-100-css-large":
			resource = fmt.Sprintf("res-%03d.css", index)
		case "referenced-resource-delete", "resource-rename-unchanged-references", "resource-rename-updated-reference":
			if index == 0 {
				resource = "old.css"
			}
		}
		writeTestFile(t, repo, fmt.Sprintf("site/docs/doc-%03d.html", index), td10Page(index, resource))
	}
	switch name {
	case "shared-100-css-svg":
		writeTestFile(t, repo, "site/assets/shared.css", "body{color:black;background:url(\"shared.svg\")}\n")
		writeTestFile(t, repo, "site/assets/shared.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle r=\"2\"/></svg>\n")
	case "unique-100-css-large":
		for index := 0; index < td10PageCount; index++ {
			writeTestFile(t, repo, fmt.Sprintf("site/assets/res-%03d.css", index), td10SizedCSS(index, "black"))
		}
	case "unused-resource-delete":
		writeTestFile(t, repo, "site/assets/unused.bin", "unused-data\n")
	case "referenced-resource-delete":
		writeTestFile(t, repo, "site/assets/old.css", "body{color:black}\n")
	case "resource-rename-unchanged-references", "resource-rename-updated-reference":
		writeTestFile(t, repo, "site/assets/old.css", "body{color:black}\n")
	}
	td10Git(t, repo, "add", ".")
	baseSHA := td10Commit(t, repo, "td10-base", "2026-01-01T00:00:00Z")
	if name == "noop" {
		return repo, td10Options(baseSHA, baseSHA), baseSHA, baseSHA
	}
	td10Git(t, repo, "checkout", "-b", "preview")
	switch name {
	case "single-document":
		writeTestFile(t, repo, "site/docs/doc-000.html", "<html><head><title>Changed 000</title></head><body>revision two</body></html>\n")
	case "shared-100-css-svg":
		writeTestFile(t, repo, "site/assets/shared.css", "body{color:blue;background:url(\"shared.svg\")}\n")
	case "unique-100-css-large":
		writeTestFile(t, repo, "site/assets/res-000.css", td10SizedCSS(0, "blue!"))
	case "unused-resource-delete", "referenced-resource-delete":
		td10Git(t, repo, "rm", "-q", "site/assets/"+map[bool]string{true: "unused.bin", false: "old.css"}[name == "unused-resource-delete"])
	case "resource-rename-unchanged-references":
		td10Git(t, repo, "mv", "site/assets/old.css", "site/assets/new.css")
	case "resource-rename-updated-reference":
		td10Git(t, repo, "mv", "site/assets/old.css", "site/assets/new.css")
		writeTestFile(t, repo, "site/docs/doc-000.html", td10Page(0, "new.css"))
	}
	td10Git(t, repo, "add", "-A")
	headSHA := td10Commit(t, repo, "td10-"+name, "2026-01-02T00:00:00Z")
	return repo, td10Options(baseSHA, headSHA), baseSHA, headSHA
}

func td10Options(baseSHA, headSHA string) BuildOptions {
	return BuildOptions{SiteID: "sre", SourcePath: "site", DefaultRef: baseSHA, HeadRef: headSHA}
}

func td10Page(index int, resource string) string {
	link := ""
	if resource != "" {
		link = fmt.Sprintf("<link rel=\"stylesheet\" href=\"../assets/%s\">", resource)
	}
	return fmt.Sprintf("<html><head><title>Document %03d</title>%s</head><body>Page %03d</body></html>\n", index, link, index)
}

func td10SizedCSS(index int, color string) string {
	prefix := fmt.Sprintf("/* resource-%03d */\nbody{color:%s}\n", index, color)
	padding := td10UniqueCSSBytes - len(prefix) - 4
	if padding < 0 {
		panic("TD10 CSS fixture prefix exceeds configured body size")
	}
	return prefix + "/*" + strings.Repeat("x", padding) + "*/"
}

func td10Git(t *testing.T, repo string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = repo
	command.Env = append(os.Environ(), "GIT_AUTHOR_DATE=2026-01-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-01-01T00:00:00Z")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func td10Commit(t *testing.T, repo, message, date string) string {
	t.Helper()
	command := exec.Command("git", "commit", "-m", message)
	command.Dir = repo
	command.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git commit %q: %v\n%s", message, err, output)
	}
	return td10Git(t, repo, "rev-parse", "HEAD")
}

func td10CompareBuilds(t *testing.T, scenario string, baseline, candidate td10BuildMeasurement) {
	t.Helper()
	if !reflect.DeepEqual(baseline.identity, candidate.identity) {
		t.Fatalf("%s output identity changed between baseline and candidate\nbaseline=%#v\ncandidate=%#v", scenario, baseline.identity, candidate.identity)
	}
	if baseline.errorText != candidate.errorText {
		t.Fatalf("%s errors changed between baseline and candidate: before=%q candidate=%q", scenario, baseline.errorText, candidate.errorText)
	}
	for index, document := range candidate.identity.Documents {
		if index > 0 && candidate.identity.Documents[index-1].Path > document.Path {
			t.Fatalf("documents are not path-sorted: %#v", candidate.identity.Documents)
		}
		if !sort.StringsAreSorted(document.ChangedResources) {
			t.Fatalf("document %q has unsorted changed resources: %#v", document.Path, document.ChangedResources)
		}
	}
}

func td10AssertExpected(t *testing.T, name string, result td10ResultIdentity, errorText string) {
	t.Helper()
	if name == "referenced-resource-delete" || name == "resource-rename-unchanged-references" {
		if errorText == "" || !strings.Contains(errorText, "missing from the source head tree") {
			t.Fatalf("expected referenced-resource deletion error, got %q", errorText)
		}
		return
	}
	if errorText != "" {
		t.Fatal(errorText)
	}
	wantOutcome, wantDocuments, wantFiles := OutcomePublished, 0, 0
	switch name {
	case "noop", "unused-resource-delete":
		wantOutcome = OutcomeNoPreview
	case "single-document":
		wantDocuments, wantFiles = 1, 1
	case "shared-100-css-svg":
		wantDocuments, wantFiles = td10PageCount, td10PageCount+2
	case "unique-100-css-large":
		wantDocuments, wantFiles = 1, 2
	case "resource-rename-updated-reference":
		wantDocuments, wantFiles = 1, 2
	default:
		t.Fatalf("unknown TD10 scenario %q", name)
	}
	if result.Outcome != wantOutcome || len(result.Documents) != wantDocuments || len(result.FilePaths) != wantFiles {
		t.Fatalf("unexpected outcome shape: outcome=%s documents=%d files=%d; want %s/%d/%d", result.Outcome, len(result.Documents), len(result.FilePaths), wantOutcome, wantDocuments, wantFiles)
	}
	if wantDocuments == 1 {
		document := result.Documents[0]
		if document.Path != "docs/doc-000.html" {
			t.Fatalf("selected document=%q, want docs/doc-000.html", document.Path)
		}
		wantReason := ReasonChanged
		if name == "unique-100-css-large" {
			wantReason = ReasonDependency
		}
		if document.Reason != wantReason {
			t.Fatalf("selected document reason=%q, want %q", document.Reason, wantReason)
		}
		if name == "unique-100-css-large" && !reflect.DeepEqual(document.ChangedResources, []string{"assets/res-000.css"}) {
			t.Fatalf("unique CSS changed resources=%#v", document.ChangedResources)
		}
	}
	if name == "shared-100-css-svg" {
		for _, document := range result.Documents {
			if document.Reason != ReasonDependency || !reflect.DeepEqual(document.ChangedResources, []string{"assets/shared.css"}) {
				t.Fatalf("shared dependency selection changed: %#v", document)
			}
		}
	}
}

func td10PreviewHTTPMetadataFingerprint(result BuildResult) string {
	hasher := sha256.New()
	td10WritePart(hasher, []byte(result.Outcome))
	manifest, _ := json.Marshal(result.Manifest)
	td10WritePart(hasher, manifest)
	paths := make([]string, 0, len(result.Files))
	for filePath := range result.Files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	for _, filePath := range paths {
		td10WritePart(hasher, []byte(filePath))
		td10WritePart(hasher, result.Files[filePath])
		td10WritePart(hasher, []byte(contentTypeFor(filePath)))
		td10WritePart(hasher, []byte("inline"))
		td10WritePart(hasher, nil) // preview objects do not claim content encoding
		td10WritePart(hasher, []byte(td10PreviewCache))
		td10WritePart(hasher, []byte("artifact-pages-preview=true"))
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

func resultIdentity(result BuildResult) td10ResultIdentity {
	groupJSON, _ := json.Marshal(result.Group)
	manifestJSON, _ := json.Marshal(result.Manifest)
	groupDigest := sha256.Sum256(groupJSON)
	manifestDigest := sha256.Sum256(manifestJSON)
	fileHasher := sha256.New()
	paths := make([]string, 0, len(result.Files))
	for filePath := range result.Files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	var fileBytes int64
	for _, filePath := range paths {
		body := result.Files[filePath]
		td10WritePart(fileHasher, []byte(filePath))
		td10WritePart(fileHasher, body)
		fileBytes += int64(len(body))
	}
	documents := make([]td10DocumentIdentity, 0, len(result.Group.Documents))
	for _, document := range result.Group.Documents {
		documents = append(documents, td10DocumentIdentity{
			Path: document.Path, Reason: document.Reason,
			ChangedResources: append([]string(nil), document.ChangedResources...),
		})
	}
	return td10ResultIdentity{
		Outcome:                        result.Outcome,
		GroupSHA256:                    hex.EncodeToString(groupDigest[:]),
		ManifestSHA256:                 hex.EncodeToString(manifestDigest[:]),
		FilesSHA256:                    hex.EncodeToString(fileHasher.Sum(nil)),
		PreviewHTTPMetadataFingerprint: td10PreviewHTTPMetadataFingerprint(result),
		FilePaths:                      paths, FileBytes: fileBytes, Documents: documents,
	}
}

func td10WritePart(hasher hash.Hash, value []byte) {
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(value)))
	_, _ = hasher.Write(length[:])
	_, _ = hasher.Write(value)
}
