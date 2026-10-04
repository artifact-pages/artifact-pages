package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
)

func TestRunPreviewPublishDryRunAndApply(t *testing.T) {
	root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	baseRef, err := gitOutputForPreviewTest(root, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	baseRef = strings.TrimSpace(baseRef)
	if err := runGitCommand(root, "branch", "preview"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", "preview"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "overview.html"), []byte("<title>Preview overview</title><h1>Preview</h1><img src=\"chart%20one.svg\">"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "chart one.svg"), []byte("<svg></svg>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "add", "docs/artifacts"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "commit", "-m", "change review preview"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", "preview"); err != nil {
		t.Fatal(err)
	}
	storageRoot := filepath.Join(root, ".local", "storage")
	before := snapshotFiles(t, storageRoot)
	args := []string{
		"preview", "publish", "--site", "sre", "--source", "docs/artifacts", "--head", "preview", "--default-ref", baseRef,
		"--base-url", "https://pages.example.test", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json",
	}
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), args, &stdout, &stderr); err != nil {
		t.Fatalf("preview publish dry-run error = %v; stderr=%s", err, stderr.String())
	}
	var planned previewPublishOutput
	if err := json.Unmarshal(stdout.Bytes(), &planned); err != nil {
		t.Fatalf("decode preview plan: %v; output=%s", err, stdout.String())
	}
	if planned.Operation != "preview publish" || planned.Outcome != "planned" || planned.Site != "sre" || planned.GroupID == "" || planned.HeadSHA == "" {
		t.Fatalf("preview plan identity = %+v", planned)
	}
	if planned.GroupListURL != "https://pages.example.test/sre/_previews?group="+strings.ReplaceAll(planned.GroupID, ":", "%3A") {
		t.Errorf("group-list URL = %q", planned.GroupListURL)
	}
	if len(planned.Documents) != 1 || !strings.Contains(planned.Documents[0].URL, "/sre/_previews/"+planned.HeadSHA+"/overview.html") {
		t.Errorf("fixed document URLs = %+v", planned.Documents)
	}
	if len(planned.Objects) < 3 || planned.Objects[len(planned.Objects)-1].Path != "manifest.json" {
		t.Errorf("planned objects = %+v; manifest should be last", planned.Objects)
	}
	if after := snapshotFiles(t, storageRoot); !equalByteMaps(before, after) {
		t.Fatalf("preview dry-run changed provider storage: before=%v after=%v", before, after)
	}

	stdout.Reset()
	stderr.Reset()
	applyArgs := make([]string, 0, len(args)-1)
	for _, arg := range args {
		if arg != "--dry-run" {
			applyArgs = append(applyArgs, arg)
		}
	}
	if err := run(context.Background(), applyArgs, &stdout, &stderr); err != nil {
		t.Fatalf("preview publish error = %v; stderr=%s", err, stderr.String())
	}
	var applied previewPublishOutput
	if err := json.Unmarshal(stdout.Bytes(), &applied); err != nil {
		t.Fatalf("decode preview result: %v; output=%s", err, stdout.String())
	}
	if applied.Outcome != "published" || applied.HeadSHA != planned.HeadSHA || applied.GroupListURL != planned.GroupListURL {
		t.Fatalf("applied preview = %+v; plan = %+v", applied, planned)
	}
	catalogBytes, err := os.ReadFile(filepath.Join(storageRoot, "_previews", "sre", "catalog.json"))
	if err != nil {
		t.Fatalf("read preview catalog: %v", err)
	}
	catalog, err := preview.DecodeCatalog(catalogBytes)
	if err != nil || len(catalog.Groups) != 1 || catalog.Groups[0].ID != applied.GroupID {
		t.Fatalf("catalog = %+v, err=%v", catalog, err)
	}
	if _, err := os.Stat(filepath.Join(storageRoot, "_previews", "sre", "revisions", applied.HeadSHA, "files", "overview.html")); err != nil {
		t.Fatalf("published preview document is missing: %v", err)
	}
}

func TestPreviewURLHelpersEncodePathAndGroupContext(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	groupURL, err := previewGroupURL("https://pages.example.test", "sre", "pr:42")
	if err != nil || groupURL != "https://pages.example.test/sre/_previews?group=pr%3A42" {
		t.Fatalf("previewGroupURL() = %q, %v", groupURL, err)
	}
	documentPath := "docs/安全 #1%2F +?.md"
	documentURL, err := previewDocumentRoute("https://pages.example.test", "sre", headSHA, documentPath, "pr:42", true)
	want := "https://pages.example.test/sre/_previews/" + headSHA + "/docs/%E5%AE%89%E5%85%A8%20%231%252F%20%2B%3F.md?group=pr%3A42"
	if err != nil || documentURL != want {
		t.Fatalf("previewDocumentRoute() = %q, %v; want %q", documentURL, err, want)
	}
	sharedRoute, err := preview.DocumentRouteHref("sre", headSHA, documentPath, "pr:42")
	if err != nil || documentURL != "https://pages.example.test"+sharedRoute {
		t.Fatalf("CLI preview URL %q differs from shared reader route %q: %v", documentURL, sharedRoute, err)
	}
	manualURL, err := previewDocumentRoute("https://pages.example.test", "sre", headSHA, "docs/report.md", "head:"+headSHA, false)
	if err != nil || strings.Contains(manualURL, "group=") {
		t.Fatalf("manual preview URL = %q, %v; want no PR reader context", manualURL, err)
	}
}

func TestPreviewPublishFailurePreservesResolvedPreviewURLs(t *testing.T) {
	root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	baseRef, err := gitOutputForPreviewTest(root, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	baseRef = strings.TrimSpace(baseRef)
	if err := runGitCommand(root, "branch", "preview-failure"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", "preview-failure"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "overview.html"), []byte("<title>Preview overview</title><h1>Preview</h1>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "add", "docs/artifacts/overview.html"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "commit", "-m", "change review preview"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", "preview-failure"); err != nil {
		t.Fatal(err)
	}
	headSHA, err := gitOutputForPreviewTest(root, "rev-parse", "preview-failure")
	if err != nil {
		t.Fatal(err)
	}
	headSHA = strings.TrimSpace(headSHA)
	manifestPath := filepath.Join(root, ".local", "storage", "_previews", "sre", "revisions", headSHA, "manifest.json")
	if err := os.MkdirAll(filepath.Dir(manifestPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(manifestPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}

	args := []string{
		"preview", "publish", "--site", "sre", "--source", "docs/artifacts", "--head", "preview-failure", "--default-ref", baseRef,
		"--base-url", "https://pages.example.test", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json",
	}
	var stdout, stderr bytes.Buffer
	err = run(context.Background(), args, &stdout, &stderr)
	if err == nil {
		t.Fatalf("preview publish error = nil; stderr=%s", stderr.String())
	}
	var commandErr *commandError
	if !errors.As(err, &commandErr) || commandErr.previewResult == nil {
		t.Fatalf("preview publish error did not retain preview result: %T %v", err, err)
	}
	failure := previewFailureResult(args, err, commandErr)
	if failure.Operation != "preview publish" || failure.Outcome != "failed" || failure.Site != "sre" || failure.Error == "" {
		t.Fatalf("failure identity = %+v", failure)
	}
	wantGroupURL := "https://pages.example.test/sre/_previews?group=head%3A" + headSHA
	if failure.GroupListURL != wantGroupURL {
		t.Errorf("failure group-list URL = %q; want %q", failure.GroupListURL, wantGroupURL)
	}
	if failure.HeadSHA != headSHA || len(failure.Documents) != 1 || !strings.Contains(failure.Documents[0].URL, "/_previews/"+headSHA+"/overview.html") {
		t.Errorf("failure preview identity/URLs = %+v", failure)
	}
	encoded, err := json.Marshal(failure)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip previewPublishOutput
	if err := json.Unmarshal(encoded, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.GroupListURL != failure.GroupListURL || len(roundTrip.Documents) != 1 || roundTrip.Outcome != "failed" {
		t.Fatalf("JSON failure envelope lost preview URLs: %+v", roundTrip)
	}
}

func TestRunPreviewPublishDistinguishesDeletionOnlyFromResourceOnlyChanges(t *testing.T) {
	root := createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	baseRef, err := gitOutputForPreviewTest(root, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	baseRef = strings.TrimSpace(baseRef)
	if err := runGitCommand(root, "checkout", "-b", "preview-deletion"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "rm", "docs/artifacts/overview.html"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "commit", "-m", "delete only document"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", baseRef); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", "-b", "preview-resource"); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "docs", "artifacts", "assets"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "assets", "data.json"), []byte("{}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "add", "docs/artifacts/assets/data.json"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "commit", "-m", "add only resource"); err != nil {
		t.Fatal(err)
	}
	if err := runGitCommand(root, "checkout", "preview-deletion"); err != nil {
		t.Fatal(err)
	}

	storageRoot := filepath.Join(root, ".local", "storage")
	before := snapshotFiles(t, storageRoot)
	baseArgs := []string{
		"preview", "publish", "--site", "sre", "--source", "docs/artifacts", "--default-ref", baseRef,
		"--base-url", "https://pages.example.test", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json",
	}
	args := append(append([]string(nil), baseArgs...), "--head", "preview-deletion")
	var stdout, stderr bytes.Buffer
	if err := run(context.Background(), args, &stdout, &stderr); err != nil {
		t.Fatalf("deletion-only dry-run error = %v; stderr=%s", err, stderr.String())
	}
	var result previewPublishOutput
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("decode deletion-only result: %v; output=%s", err, stdout.String())
	}
	if result.Outcome != "no-preview" || result.GroupID == "" || result.HeadSHA == "" || len(result.Documents) != 0 || result.GroupListURL == "" {
		t.Fatalf("deletion-only result = %+v", result)
	}
	if after := snapshotFiles(t, storageRoot); !equalByteMaps(before, after) {
		t.Fatalf("deletion-only dry-run changed provider storage: before=%v after=%v", before, after)
	}

	stdout.Reset()
	stderr.Reset()
	args = append(append([]string(nil), baseArgs...), "--head", "preview-resource")
	if err := run(context.Background(), args, &stdout, &stderr); err != nil {
		t.Fatalf("resource-only dry-run error = %v; stderr=%s", err, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || result.Outcome != "no-preview" {
		t.Fatalf("resource-only result = %+v err=%v", result, err)
	}
	if after := snapshotFiles(t, storageRoot); !equalByteMaps(before, after) {
		t.Fatalf("rejected resource-only dry-run changed provider storage: before=%v after=%v", before, after)
	}
}

func TestValidatePreviewPublicOriginRequiresAnOrigin(t *testing.T) {
	for _, value := range []string{"", "https://user:secret@example.test", "https://example.test/site", "https://example.test?x=1", "ftp://example.test"} {
		if _, err := validatePreviewPublicOrigin(value); err == nil {
			t.Errorf("validatePreviewPublicOrigin(%q) succeeded", value)
		}
	}
	if got, err := validatePreviewPublicOrigin("https://example.test/"); err != nil || got != "https://example.test" {
		t.Fatalf("validatePreviewPublicOrigin() = %q, %v", got, err)
	}
}

func gitOutputForPreviewTest(root string, args ...string) (string, error) {
	command := exec.Command("git", args...)
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func equalByteMaps(left, right map[string][]byte) bool {
	if len(left) != len(right) {
		return false
	}
	for path, contents := range left {
		if !bytes.Equal(contents, right[path]) {
			return false
		}
	}
	return true
}

func TestRunPreviewPublishDefaultsSourceAndBaseURLFromRegistryAndConfig(t *testing.T) {
	createLocalSitePublishCheckout(t, registeredLocalSiteManifest+"publicBaseURL: http://localhost:8080\n")
	run1 := func(args ...string) (previewPublishOutput, error) {
		var stdout, stderr bytes.Buffer
		full := append([]string{"preview", "publish", "--site", "sre", "--default-ref", "HEAD", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json"}, args...)
		err := run(context.Background(), full, &stdout, &stderr)
		var out previewPublishOutput
		if err == nil {
			if decodeErr := json.Unmarshal(stdout.Bytes(), &out); decodeErr != nil {
				t.Fatalf("decode %q: %v", stdout.String(), decodeErr)
			}
		}
		return out, err
	}

	out, err := run1()
	if err != nil {
		t.Fatalf("omitted --source and --base-url should default: %v", err)
	}
	if !strings.HasPrefix(out.GroupListURL, "http://localhost:8080/sre/_previews?group=") {
		t.Errorf("group-list URL = %q, want the config public base URL", out.GroupListURL)
	}

	out, err = run1("--base-url", "https://explicit.example.test")
	if err != nil || !strings.HasPrefix(out.GroupListURL, "https://explicit.example.test/sre/") {
		t.Errorf("explicit --base-url must win: %q, %v", out.GroupListURL, err)
	}

	if _, err = run1("--source", "docs/other"); err == nil || !strings.Contains(err.Error(), "registered to acme/sre:docs/artifacts") {
		t.Errorf("an explicit non-matching --source must still fail, got %v", err)
	}
	if _, err = run1("--source", "docs/artifacts"); err != nil {
		t.Errorf("an explicit matching --source must work: %v", err)
	}
}

func TestRunPreviewPublishRequiresBaseURLWhenConfigHasNone(t *testing.T) {
	createLocalSitePublishCheckout(t, registeredLocalSiteManifest)
	var stdout, stderr bytes.Buffer
	err := run(context.Background(), []string{"preview", "publish", "--site", "sre", "--default-ref", "HEAD", "--config", "artifact-pages.yaml", "--dry-run", "--format", "json"}, &stdout, &stderr)
	if err == nil || !strings.Contains(err.Error(), "--base-url is required") || !strings.Contains(err.Error(), "publicBaseURL") {
		t.Fatalf("error = %v", err)
	}
	if code := commandExitCode(err); code != 2 {
		t.Errorf("exit code = %d, want 2", code)
	}
}
