package preview

import (
	"bytes"
	"context"
	"errors"
	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestNormalizeRepositoryValidatesRepositoryNameComponent(t *testing.T) {
	for _, name := range []string{".github", "platform.config", "123project"} {
		got, err := normalizeRepository("Acme/" + name)
		if err != nil {
			t.Errorf("normalizeRepository(%q) error = %v", name, err)
			continue
		}
		if got != "Acme/"+name {
			t.Errorf("normalizeRepository(%q) = %q, want original spelling", name, got)
		}
	}

	for _, name := range []string{strings.Repeat("a", 101), "..", "repo/child", "repo?name", "repo.git", "repo.GIT"} {
		if got, err := normalizeRepository("Acme/" + name); err == nil {
			t.Errorf("normalizeRepository(%q) = %q, want invalid repository name rejected", name, got)
		}
	}
}

func TestBuildFromGitUsesHeadTreeAndCollectsLocalResources(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/old.md", "# Old\n")
	writeTestFile(t, repo, "site/docs/report.md", "# Base Report\n")
	writeTestFile(t, repo, "site/unchanged.md", "# Unchanged\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")

	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/report.md", "# Preview Report\n\n![plot](../media/plot.svg)\n")
	writeTestFile(t, repo, "site/docs/view.html", `<!doctype html><title>Preview View</title><link rel="stylesheet" href="../assets/theme.css"><script type="module" src="../assets/app.js"></script><img src="../media/plot.svg">`)
	writeTestFile(t, repo, "site/media/plot.svg", `<svg xmlns="http://www.w3.org/2000/svg"><image href="icon.png"/></svg>`)
	writeTestFile(t, repo, "site/media/icon.png", "png-source")
	writeTestFile(t, repo, "site/assets/theme.css", `@import "./extra.css"; body { background: url("../media/paper.webp"); }`)
	writeTestFile(t, repo, "site/assets/extra.css", `@font-face { src: url("../fonts/test.woff2"); }`)
	writeTestFile(t, repo, "site/assets/app.js", `import "./feature.js"; console.log('preview');`)
	writeTestFile(t, repo, "site/assets/feature.js", `export const ready = true;`)
	writeTestFile(t, repo, "site/media/paper.webp", "webp-source")
	writeTestFile(t, repo, "site/fonts/test.woff2", "font-source")
	writeTestFile(t, repo, "site/assets/manual-data.bin", "explicit resource")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "preview docs and dependencies")

	gitTest(t, repo, "checkout", "main")
	writeTestFile(t, repo, "site/docs/default-only.html", "<title>Default only</title>")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "advance default branch")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/report.md", "# Working tree content must not be read\n")

	result, err := BuildFromGit(context.Background(), BuildOptions{
		RepositoryDir:             repo,
		SiteID:                    "sre",
		SourcePath:                "site",
		DefaultRef:                "main",
		HeadRef:                   "preview",
		Repository:                "acme/project",
		PullRequestURL:            "https://github.com/acme/project/pull/42",
		PullRequestHeadRepository: "acme/project",
		PullRequestHeadSHA:        gitTest(t, repo, "rev-parse", "preview"),
		ExplicitResources:         []string{"assets/*.bin"},
		Now:                       func() time.Time { return time.Date(2026, 9, 27, 1, 2, 3, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("BuildFromGit() error = %v", err)
	}
	if result.Outcome != OutcomePublished || result.Group.ID != "pr:42" || result.Group.Kind != "pull-request" {
		t.Fatalf("unexpected build identity: %#v", result)
	}
	if got := string(result.Files["docs/report.md"]); got != "# Preview Report\n\n![plot](../media/plot.svg)\n" {
		t.Fatalf("read bytes from working tree, got %q", got)
	}
	if _, exists := result.Files["docs/default-only.html"]; exists {
		t.Fatal("default-branch-only document was incorrectly selected")
	}
	for _, name := range []string{"media/plot.svg", "media/icon.png", "assets/theme.css", "assets/extra.css", "assets/app.js", "assets/feature.js", "media/paper.webp", "fonts/test.woff2", "assets/manual-data.bin"} {
		if _, exists := result.Files[name]; !exists {
			t.Errorf("local dependency %q was not collected", name)
		}
	}
	if len(result.Manifest.Documents) != 2 || result.Manifest.Documents[0].Title != "Preview Report" || result.Manifest.Documents[1].Title != "Preview View" {
		t.Fatalf("unexpected document metadata: %#v", result.Manifest.Documents)
	}
	contentType := ""
	for _, file := range result.Manifest.Files {
		if file.Path == "docs/report.md" {
			contentType = file.ContentType
		}
	}
	if contentType != "text/markdown; charset=utf-8" {
		t.Fatalf("Markdown MIME type = %q", contentType)
	}
	if _, exists := result.Files["unchanged.md"]; exists {
		t.Fatal("unchanged document was incorrectly selected")
	}
	if result.Manifest.HeadSHA != gitTest(t, repo, "rev-parse", "preview") || result.Manifest.DefaultHead != gitTest(t, repo, "rev-parse", "main") {
		t.Fatalf("manifest source/default heads do not match the selected refs: %#v", result.Manifest)
	}
	if current, err := os.ReadFile(filepath.Join(repo, "site/docs/report.md")); err != nil || string(current) != "# Working tree content must not be read\n" {
		t.Fatalf("BuildFromGit changed the working tree: %q, %v", current, err)
	}
}

func TestBuildFromGitSameHeadRetryAfterDefaultBranchAdvances(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/report.md", "# Base report\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")

	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/report.md", "# Preview report\n")
	gitTest(t, repo, "commit", "-am", "update preview report")
	headSHA := gitTest(t, repo, "rev-parse", "preview")

	options := BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
		Repository: "acme/project", PullRequestURL: "https://github.com/acme/project/pull/42",
		PullRequestHeadRepository: "acme/project", PullRequestHeadSHA: headSHA,
		Now: func() time.Time { return time.Date(2026, 9, 27, 1, 2, 3, 0, time.UTC) },
	}
	original, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit(initial) error = %v", err)
	}
	store := newMemoryPreviewStore()
	if err := Publish(context.Background(), store, original); err != nil {
		t.Fatalf("Publish(initial) error = %v", err)
	}

	gitTest(t, repo, "checkout", "main")
	writeTestFile(t, repo, "notes/default-only.txt", "unrelated default branch change\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "advance default branch outside site")
	gitTest(t, repo, "checkout", "preview")
	options.Now = func() time.Time { return time.Date(2026, 9, 28, 1, 2, 3, 0, time.UTC) }
	retry, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatalf("BuildFromGit(retry) error = %v", err)
	}

	if original.Manifest.DefaultHead == retry.Manifest.DefaultHead {
		t.Fatal("fixture did not advance the recorded default-branch HEAD")
	}
	if original.Manifest.HeadSHA != retry.Manifest.HeadSHA || original.Manifest.MergeBase != retry.Manifest.MergeBase {
		t.Fatalf("preview identity changed: initial=%+v retry=%+v", original.Manifest, retry.Manifest)
	}
	if !reflect.DeepEqual(original.Manifest.Documents, retry.Manifest.Documents) || !reflect.DeepEqual(original.Files, retry.Files) || original.Manifest.BundleDigest != retry.Manifest.BundleDigest {
		t.Fatal("default-only commit changed the preview document selection or bundle")
	}
	if original.Manifest.CreatedAt == retry.Manifest.CreatedAt || original.Group.UpdatedAt == retry.Group.UpdatedAt {
		t.Fatal("fixture did not distinguish manifest and discovery comparison timestamps")
	}

	plan, err := PlanPublication(context.Background(), store, retry)
	if err != nil {
		t.Fatalf("PlanPublication(retry) error = %v", err)
	}
	if len(plan.Objects) != len(retry.Files)+1 || len(plan.CatalogChanges) != 0 {
		t.Fatalf("retry plan = %+v; want every object retained and no catalog changes", plan)
	}
	for _, object := range plan.Objects {
		if object.Action != "retain" {
			t.Errorf("retry plan object %q action = %q, want retain", object.Path, object.Action)
		}
	}

	manifestKey, _ := ManifestKey("sre", headSHA)
	manifestBefore, err := store.ReadObject(context.Background(), manifestKey)
	if err != nil {
		t.Fatalf("read stored manifest before retry: %v", err)
	}
	catalogKey, _ := CatalogKey("sre")
	catalogBefore, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatalf("read stored catalog before retry: %v", err)
	}
	createCounts := make(map[string]int, len(retry.Files)+1)
	for filePath := range retry.Files {
		key, keyErr := FileKey("sre", headSHA, filePath)
		if keyErr != nil {
			t.Fatal(keyErr)
		}
		createCounts[key] = store.createCallCount(key)
	}
	createCounts[manifestKey] = store.createCallCount(manifestKey)

	if err := Publish(context.Background(), store, retry); err != nil {
		t.Fatalf("Publish(same head after default branch advance) error = %v", err)
	}
	manifestAfter, err := store.ReadObject(context.Background(), manifestKey)
	if err != nil || !bytes.Equal(manifestAfter, manifestBefore) {
		t.Fatalf("retry rewrote completed manifest: bytesEqual=%t err=%v", bytes.Equal(manifestAfter, manifestBefore), err)
	}
	storedManifest, err := DecodeManifest(manifestAfter)
	if err != nil {
		t.Fatalf("DecodeManifest(stored retry record) error = %v", err)
	}
	if storedManifest.DefaultHead != original.Manifest.DefaultHead || storedManifest.CreatedAt != original.Manifest.CreatedAt {
		t.Fatalf("retry refreshed immutable provenance: stored=%+v original=%+v", storedManifest, original.Manifest)
	}
	catalogAfter, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil || !bytes.Equal(catalogAfter, catalogBefore) {
		t.Fatalf("retry changed discovery catalog: bytesEqual=%t err=%v", bytes.Equal(catalogAfter, catalogBefore), err)
	}
	storedCatalog, err := DecodeCatalog(catalogAfter)
	if err != nil {
		t.Fatalf("DecodeCatalog(stored retry discovery) error = %v", err)
	}
	if len(storedCatalog.Groups) != 1 || storedCatalog.Groups[0].UpdatedAt != original.Group.UpdatedAt || storedCatalog.Groups[0].UpdatedAt == retry.Group.UpdatedAt {
		t.Fatalf("retry refreshed discovery group context: stored=%+v initial=%+v retry=%+v", storedCatalog.Groups, original.Group, retry.Group)
	}
	for key, before := range createCounts {
		if got := store.createCallCount(key); got != before {
			t.Errorf("retry rewrote immutable object %q: create calls %d -> %d", key, before, got)
		}
	}
}

func TestBuildFromGitDeletionRemovesPRCatalogGroup(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/report.md", "# Report\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/report.md", "# Updated report\n")
	gitTest(t, repo, "commit", "-am", "update report")
	options := BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
		Repository: "acme/project", PullRequestURL: "https://github.com/acme/project/pull/42", PullRequestHeadRepository: "acme/project",
		PullRequestHeadSHA: gitTest(t, repo, "rev-parse", "preview"),
	}
	first, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	previewRoot := filepath.Join(t.TempDir(), "_previews")
	if err := WriteLocal(previewRoot, first); err != nil {
		t.Fatalf("publish first build: %v", err)
	}
	if err := os.Remove(filepath.Join(repo, "site/docs/report.md")); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", "-A")
	gitTest(t, repo, "commit", "-m", "remove report")
	options.PullRequestHeadSHA = gitTest(t, repo, "rev-parse", "preview")
	second, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if second.Outcome != OutcomeNoPreview || second.Group.ID != "pr:42" || second.Site != "sre" {
		t.Fatalf("unexpected deletion outcome: %#v", second)
	}
	if err := WriteLocal(previewRoot, second); err != nil {
		t.Fatalf("remove catalog group: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(previewRoot, "sre/catalog.json"))
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := DecodeCatalog(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Groups) != 0 {
		t.Fatalf("deletion left preview groups in catalog: %#v", catalog.Groups)
	}
}

func TestBuildFromGitResourceWithoutDependentsIsNoPreview(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/report.md", "# Report\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/assets/data.json", "{}\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "resource only")
	result, err := BuildFromGit(context.Background(), BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
	})
	if err != nil || result.Outcome != OutcomeNoPreview {
		t.Fatalf("BuildFromGit() = %#v, %v; want no-preview", result.Outcome, err)
	}
}

func dependencyOptions(repo string) BuildOptions {
	return BuildOptions{RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview"}
}

func newDependencyRepository(t *testing.T) string {
	t.Helper()
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/a.html", "<html><head><title>A</title><link rel=\"stylesheet\" href=\"assets/site.css\"></head></html>\n")
	writeTestFile(t, repo, "site/b.html", "<html><head><title>B</title><link rel=\"stylesheet\" href=\"assets/theme.css\"></head></html>\n")
	writeTestFile(t, repo, "site/c.md", "# C\n\n![pic](img/pic.png)\n")
	writeTestFile(t, repo, "site/d.md", "# D\n\nNo resources.\n")
	writeTestFile(t, repo, "site/assets/site.css", "body{color:red}\n")
	writeTestFile(t, repo, "site/assets/theme.css", "@import \"base.css\";\n")
	writeTestFile(t, repo, "site/assets/base.css", "p{margin:0}\n")
	writeTestFile(t, repo, "site/img/pic.png", "png-v1")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	return repo
}

func documentReasons(result BuildResult) map[string]string {
	reasons := map[string]string{}
	for _, document := range result.Group.Documents {
		reasons[document.Path] = document.Reason
	}
	return reasons
}

func TestBuildFromGitCSSChangePreviewsDependentDocuments(t *testing.T) {
	repo := newDependencyRepository(t)
	writeTestFile(t, repo, "site/assets/site.css", "body{color:blue}\n")
	gitTest(t, repo, "commit", "-am", "css")
	result, err := BuildFromGit(context.Background(), dependencyOptions(repo))
	if err != nil {
		t.Fatal(err)
	}
	if result.Outcome != OutcomePublished || len(result.Group.Documents) != 1 {
		t.Fatalf("unexpected result: %#v", result.Group.Documents)
	}
	document := result.Group.Documents[0]
	if document.Path != "a.html" || document.Reason != ReasonDependency || len(document.ChangedResources) != 1 || document.ChangedResources[0] != "assets/site.css" {
		t.Fatalf("document = %#v", document)
	}
	if _, ok := result.Files["assets/site.css"]; !ok {
		t.Fatal("changed stylesheet missing from bundle")
	}
	if err := ValidateManifest(result.Manifest); err != nil {
		t.Fatal(err)
	}
}

func TestBuildFromGitTransitiveCSSImportAffectsDocument(t *testing.T) {
	repo := newDependencyRepository(t)
	writeTestFile(t, repo, "site/assets/base.css", "p{margin:1px}\n")
	gitTest(t, repo, "commit", "-am", "imported css")
	result, err := BuildFromGit(context.Background(), dependencyOptions(repo))
	if err != nil {
		t.Fatal(err)
	}
	reasons := documentReasons(result)
	if len(reasons) != 1 || reasons["b.html"] != ReasonDependency {
		t.Fatalf("reasons = %#v", reasons)
	}
	if got := result.Group.Documents[0].ChangedResources; len(got) != 1 || got[0] != "assets/base.css" {
		t.Fatalf("changedResources = %#v", got)
	}
}

func TestBuildFromGitImageChangeAffectsMarkdown(t *testing.T) {
	repo := newDependencyRepository(t)
	writeTestFile(t, repo, "site/img/pic.png", "png-v2")
	gitTest(t, repo, "commit", "-am", "image")
	result, err := BuildFromGit(context.Background(), dependencyOptions(repo))
	if err != nil {
		t.Fatal(err)
	}
	reasons := documentReasons(result)
	if len(reasons) != 1 || reasons["c.md"] != ReasonDependency {
		t.Fatalf("reasons = %#v", reasons)
	}
}

func TestBuildFromGitMixedChangedAndDependencyDocumentsAreSorted(t *testing.T) {
	repo := newDependencyRepository(t)
	writeTestFile(t, repo, "site/assets/site.css", "body{color:blue}\n")
	writeTestFile(t, repo, "site/img/pic.png", "png-v2")
	writeTestFile(t, repo, "site/d.md", "# D\n\nEdited.\n")
	gitTest(t, repo, "commit", "-am", "mixed")
	result, err := BuildFromGit(context.Background(), dependencyOptions(repo))
	if err != nil {
		t.Fatal(err)
	}
	want := []Document{{Path: "a.html", Reason: ReasonDependency}, {Path: "c.md", Reason: ReasonDependency}, {Path: "d.md", Reason: ReasonChanged}}
	if len(result.Group.Documents) != len(want) {
		t.Fatalf("documents = %#v", result.Group.Documents)
	}
	for index, document := range result.Group.Documents {
		if document.Path != want[index].Path || document.Reason != want[index].Reason {
			t.Fatalf("documents[%d] = %#v, want %#v", index, document, want[index])
		}
	}
	if result.Group.Documents[2].ChangedResources != nil {
		t.Fatalf("changed document lists resources: %#v", result.Group.Documents[2])
	}
}

func TestBuildFromGitDeletedReferencedResourceIsStillAnError(t *testing.T) {
	repo := newDependencyRepository(t)
	gitTest(t, repo, "rm", "-q", "site/assets/site.css")
	gitTest(t, repo, "commit", "-m", "delete css")
	_, err := BuildFromGit(context.Background(), dependencyOptions(repo))
	if err == nil || !strings.Contains(err.Error(), "assets/site.css") || !strings.Contains(err.Error(), "missing") {
		t.Fatalf("BuildFromGit() error = %v, want missing resource error", err)
	}
}

func TestBuildFromGitNoChangesUnderSourceIsNoPreview(t *testing.T) {
	repo := newDependencyRepository(t)
	writeTestFile(t, repo, "other/file.txt", "x")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "elsewhere")
	result, err := BuildFromGit(context.Background(), dependencyOptions(repo))
	if err != nil || result.Outcome != OutcomeNoPreview {
		t.Fatalf("BuildFromGit() = %#v, %v; want no-preview", result.Outcome, err)
	}
}

func TestBuildAndPublishLeavesCatalogUntouchedWhenChangesAreNotPreviewable(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/report.md", "# Base\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview-docs")
	gitTest(t, repo, "checkout", "preview-docs")
	writeTestFile(t, repo, "site/docs/report.md", "# Preview\n")
	gitTest(t, repo, "commit", "-am", "update report")

	store, err := NewDirectoryStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	baseOptions := BuildOptions{RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main"}
	baseOptions.HeadRef = "preview-docs"
	if _, err := BuildAndPublish(context.Background(), store, baseOptions); err != nil {
		t.Fatalf("BuildAndPublish(document change) error = %v", err)
	}
	catalogKey, _ := CatalogKey("sre")
	catalogBefore, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil {
		t.Fatalf("read catalog before resource-only change: %v", err)
	}

	gitTest(t, repo, "checkout", "main")
	gitTest(t, repo, "branch", "preview-resources")
	gitTest(t, repo, "checkout", "preview-resources")
	writeTestFile(t, repo, "site/assets/data.json", "{}\n")
	gitTest(t, repo, "add", "site/assets/data.json")
	gitTest(t, repo, "commit", "-m", "resource only")
	baseOptions.HeadRef = "preview-resources"
	if _, err := BuildAndPublish(context.Background(), store, baseOptions); err != nil {
		t.Fatalf("BuildAndPublish(resource-only change) error = %v", err)
	}
	catalogAfter, err := store.ReadObject(context.Background(), catalogKey)
	if err != nil || !bytes.Equal(catalogAfter, catalogBefore) {
		t.Fatalf("catalog after rejected resource-only change changed: bytesEqual=%t err=%v", bytes.Equal(catalogAfter, catalogBefore), err)
	}
}

func TestBuildFromGitSelectsRenameDestinationAndRejectsSymlinks(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/old.md", "# Renamed document\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	gitTest(t, repo, "mv", "site/docs/old.md", "site/docs/new.md")
	gitTest(t, repo, "commit", "-m", "rename document")
	options := BuildOptions{RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview"}
	result, err := BuildFromGit(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifest.Documents) != 1 || result.Manifest.Documents[0].Path != "docs/new.md" {
		t.Fatalf("rename selected unexpected documents: %#v", result.Manifest.Documents)
	}
	if _, exists := result.Files["docs/old.md"]; exists {
		t.Fatal("rename source path was included")
	}
	if err := os.Symlink("../../secret", filepath.Join(repo, "site/docs/unsafe.md")); err != nil {
		t.Fatal(err)
	}
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "add symlink document")
	if _, err := BuildFromGit(context.Background(), options); err == nil || !strings.Contains(err.Error(), "not a regular file") {
		t.Fatalf("BuildFromGit() error = %v, want symlink rejection", err)
	}
}

func TestBuildFromGitRejectsRootRelativeLocalResourcesAndForkPRs(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/view.html", `<title>View</title><img src="/assets/logo.svg">`)
	writeTestFile(t, repo, "site/assets/logo.svg", `<svg xmlns="http://www.w3.org/2000/svg"></svg>`)
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/view.html", `<title>Changed</title><img src="/assets/logo.svg">`)
	gitTest(t, repo, "commit", "-am", "change view")
	options := BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
	}
	if _, err := BuildFromGit(context.Background(), options); err == nil || !strings.Contains(err.Error(), "root-relative resource") {
		t.Fatalf("BuildFromGit() error = %v, want a root-relative resource error", err)
	}
	options.Repository = "acme/project"
	options.PullRequestURL = "https://github.com/acme/project/pull/42"
	options.PullRequestHeadSHA = gitTest(t, repo, "rev-parse", "preview")
	options.PullRequestHeadRepository = "acme/project"
	options.Repository = "someone/else"
	if _, err := BuildFromGit(context.Background(), options); err == nil || !strings.Contains(err.Error(), "target and originate") {
		t.Fatalf("BuildFromGit() error = %v, want wrong-repository PR rejection", err)
	}
	options.Repository = "acme/project"
	options.PullRequestHeadRepository = "fork/project"
	if _, err := BuildFromGit(context.Background(), options); err == nil || !strings.Contains(err.Error(), "originate from registered repository") {
		t.Fatalf("BuildFromGit() error = %v, want fork-origin PR rejection", err)
	}
	options.PullRequestHeadRepository = "acme/project"
	options.PullRequestHeadSHA = "ffffffffffffffffffffffffffffffffffffffff"
	if _, err := BuildFromGit(context.Background(), options); err == nil || !strings.Contains(err.Error(), "head SHA must match") {
		t.Fatalf("BuildFromGit() error = %v, want PR head mismatch rejection", err)
	}
}

func TestGroupIdentityRejectsPercentEncodedRepositoryPath(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	for _, pullRequestURL := range []string{
		"https://github.com/%61cme/project/pull/42",
		"https://github.com/acme/%70roject/pull/42",
	} {
		_, _, _, err := groupIdentity(BuildOptions{
			Repository:                "acme/project",
			PullRequestURL:            pullRequestURL,
			PullRequestHeadRepository: "acme/project",
			PullRequestHeadSHA:        headSHA,
		}, headSHA)
		if err == nil {
			t.Errorf("groupIdentity accepted non-canonical URL %q", pullRequestURL)
		}
	}
}

func TestBuildFromGitRejectsMissingOutOfTreeAndDocumentResources(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/report.md", "# Base\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/report.md", "# Preview\n")
	gitTest(t, repo, "commit", "-am", "change report")
	baseOptions := BuildOptions{RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview"}
	for _, testCase := range []struct {
		path string
		want string
	}{
		{path: "assets/missing.css", want: "did not match a file"},
		{path: "../outside.css", want: "non-canonical preview source-relative path"},
		{path: "docs/report.md", want: "unchanged documents cannot be included as resources"},
		{path: "assets/*.missing", want: "did not match a file"},
		{path: "assets/[", want: "syntax error"},
		{path: "docs/*.md", want: "matched document"},
	} {
		options := baseOptions
		options.ExplicitResources = []string{testCase.path}
		if _, err := BuildFromGit(context.Background(), options); err == nil || !strings.Contains(err.Error(), testCase.want) {
			t.Errorf("resource %q: BuildFromGit() error = %v, want %q", testCase.path, err, testCase.want)
		}
	}
}

func TestBuildFromGitDoesNotGuessRuntimeConstructedResources(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/index.html", "<!doctype html><script src=\"assets/app.js\"></script>\n")
	writeTestFile(t, repo, "site/assets/app.js", "const name = new URLSearchParams(location.search).get('part'); fetch('./parts/' + name + '.json');\n")
	writeTestFile(t, repo, "site/parts/summary.json", "{\"summary\":true}\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/index.html", "<!doctype html><title>Runtime resource</title><script src=\"assets/app.js\"></script>\n")
	gitTest(t, repo, "commit", "-am", "update document")

	result, err := BuildFromGit(context.Background(), BuildOptions{
		RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview",
	})
	if err != nil {
		t.Fatalf("BuildFromGit() error = %v", err)
	}
	if _, included := result.Files["parts/summary.json"]; included {
		t.Fatal("preview builder guessed the value of a runtime-constructed resource URL")
	}
	if _, included := result.Files["assets/app.js"]; !included {
		t.Fatal("preview builder omitted the statically referenced script containing the runtime URL")
	}
}

func TestWriteLocalRejectsChangedBytesForImmutableHead(t *testing.T) {
	repo := newTestRepository(t)
	writeTestFile(t, repo, "site/docs/report.md", "# Base\n")
	gitTest(t, repo, "add", ".")
	gitTest(t, repo, "commit", "-m", "base")
	gitTest(t, repo, "branch", "preview")
	gitTest(t, repo, "checkout", "preview")
	writeTestFile(t, repo, "site/docs/report.md", "# Preview\n")
	gitTest(t, repo, "commit", "-am", "update report")
	result, err := BuildFromGit(context.Background(), BuildOptions{RepositoryDir: repo, SiteID: "sre", SourcePath: "site", DefaultRef: "main", HeadRef: "preview"})
	if err != nil {
		t.Fatal(err)
	}
	previewRoot := filepath.Join(t.TempDir(), "_previews")
	if err := WriteLocal(previewRoot, result); err != nil {
		t.Fatal(err)
	}
	if err := WriteLocal(previewRoot, result); err != nil {
		t.Fatalf("idempotent same-head publish failed: %v", err)
	}
	result.Files["docs/report.md"] = []byte("# Changed bytes\n")
	result.Manifest.Files = describeFiles(result.Files)
	result.Manifest.BundleDigest = digestBundle(result.Files)
	if err := WriteLocal(previewRoot, result); !errors.Is(err, ErrImmutableRevisionMismatch) {
		t.Fatalf("WriteLocal() error = %v, want immutable mismatch", err)
	}
}

func TestPreviewPathAndRecordValidation(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	fileKey, err := FileKey("sre", headSHA, "docs/安全 hello world%#+.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := "/_previews/sre/revisions/" + headSHA + "/files/docs/%E5%AE%89%E5%85%A8%20hello%20world%25%23%2B.md"; fileKey != want {
		t.Fatalf("FileKey() = %q, want %q", fileKey, want)
	}
	if _, err := FileKey("sre", headSHA, "../escape.md"); err == nil {
		t.Fatal("FileKey accepted path traversal")
	}
	catalog := Catalog{SchemaVersion: SchemaVersion, Site: "sre", Groups: []Group{{
		ID: "pr:42", Kind: "pull-request", HeadSHA: headSHA, PRURL: "https://github.com/acme/project/pull/42", UpdatedAt: "2026-09-27T00:00:00Z",
		Documents: []Document{{Path: "docs/report.md", Title: "Report", Format: "markdown"}},
	}}}
	encoded, err := EncodeCatalog(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeCatalog(append(encoded, []byte(` {}`)...)); err == nil {
		t.Fatal("DecodeCatalog accepted a trailing JSON value")
	}
	if _, err := DecodeCatalog([]byte(strings.Replace(string(encoded), "/pull/42", "/pull/43", 1))); err == nil {
		t.Fatal("DecodeCatalog accepted a PR URL that does not match its group")
	}
	if _, err := DecodeCatalog([]byte(strings.Replace(string(encoded), "github.com/acme", "github.com/%61cme", 1))); err == nil {
		t.Fatal("DecodeCatalog accepted a percent-encoded non-canonical PR URL")
	}
}

func TestPreviewFixtureRecordsAndStrictValidation(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	catalogBytes, err := os.ReadFile("../../../fixtures/storage/_previews/sre/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := DecodeCatalog(catalogBytes)
	if err != nil {
		t.Fatalf("DecodeCatalog(fixture) error = %v", err)
	}
	if len(catalog.Groups) != 4 {
		t.Fatalf("fixture has %d groups, want 4", len(catalog.Groups))
	}
	for _, groupID := range []string{"pr:42", "pr:43", "head:" + headSHA} {
		found := false
		for _, group := range catalog.Groups {
			if group.ID == groupID {
				found = group.HeadSHA == headSHA
				break
			}
		}
		if !found {
			t.Errorf("fixture is missing group %q on the shared head", groupID)
		}
	}

	manifestPath := "../../../fixtures/storage/_previews/sre/revisions/" + headSHA + "/manifest.json"
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := DecodeManifest(manifestBytes)
	if err != nil {
		t.Fatalf("DecodeManifest(fixture) error = %v", err)
	}
	if manifest.Site != "sre" || manifest.HeadSHA != headSHA || len(manifest.Documents) != 3 {
		t.Fatalf("unexpected fixture manifest: %#v", manifest)
	}
	files := make(map[string][]byte, len(manifest.Files))
	filesRoot := filepath.Join(filepath.Dir(manifestPath), "files")
	for _, file := range manifest.Files {
		content, err := os.ReadFile(filepath.Join(filesRoot, filepath.FromSlash(file.Path)))
		if err != nil {
			t.Fatalf("read preview fixture file %q: %v", file.Path, err)
		}
		files[file.Path] = content
	}
	if !reflect.DeepEqual(manifest.Files, describeFiles(files)) || manifest.BundleDigest != digestBundle(files) {
		t.Fatal("preview fixture manifest file records or bundle digest do not match the committed files")
	}
	if _, err := DecodeManifest([]byte(strings.Replace(string(manifestBytes), `"schemaVersion": 1`, `"schemaVersion": 2`, 1))); !compat.Is(err) {
		t.Fatalf("DecodeManifest error = %v, want an unsupported schema error", err)
	}
	if _, err := DecodeCatalog([]byte(strings.Replace(string(catalogBytes), `"schemaVersion": 1`, `"schemaVersion": 2, "newShape": {}`, 1))); !compat.Is(err) {
		t.Fatalf("DecodeCatalog error = %v, want an unsupported schema error", err)
	}
	// Reader rule: unknown fields are ignored.
	withUnknown := append(append([]byte(nil), catalogBytes[:len(catalogBytes)-2]...), []byte(`,"unknown":true}`)...)
	if _, err := DecodeCatalog(withUnknown); err != nil {
		t.Fatalf("DecodeCatalog rejected an unknown field: %v", err)
	}
	duplicateGroupCatalog := catalog
	duplicateGroupCatalog.Groups = append(append([]Group(nil), catalog.Groups...), catalog.Groups[0])
	if _, err := EncodeCatalog(duplicateGroupCatalog); err == nil {
		t.Fatal("EncodeCatalog accepted a duplicate group ID")
	}
	unsafeManifest := manifest
	unsafeManifest.Documents = append([]Document(nil), manifest.Documents...)
	unsafeManifest.Documents[0].Path = "../escape.md"
	if err := ValidateManifest(unsafeManifest); err == nil {
		t.Fatal("ValidateManifest accepted a traversal document path")
	}
}

func TestDirectoryStoreDecodesCanonicalFileKeySegments(t *testing.T) {
	const headSHA = "0123456789abcdef0123456789abcdef01234567"
	const sourcePath = "guides/review résumé #% +?.md"
	root := t.TempDir()
	store, err := NewDirectoryStore(root)
	if err != nil {
		t.Fatal(err)
	}
	key, err := FileKey("sre", headSHA, sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte("preview bytes")
	if err := store.CreateImmutableObject(context.Background(), key, want); err != nil {
		t.Fatalf("CreateImmutableObject() error = %v", err)
	}
	localPath := filepath.Join(root, "sre", "revisions", headSHA, "files", filepath.FromSlash(sourcePath))
	if actual, err := os.ReadFile(localPath); err != nil || string(actual) != string(want) {
		t.Fatalf("local object bytes = %q, %v; want %q", actual, err, want)
	}
	actual, err := store.ReadObject(context.Background(), key)
	if err != nil || string(actual) != string(want) {
		t.Fatalf("ReadObject() = %q, %v; want %q", actual, err, want)
	}
}

func newTestRepository(t *testing.T) string {
	t.Helper()
	repo := t.TempDir()
	gitTest(t, repo, "init", "-b", "main")
	gitTest(t, repo, "config", "user.email", "preview-test@example.com")
	gitTest(t, repo, "config", "user.name", "Preview Test")
	return repo
}

func writeTestFile(t *testing.T, root, relativePath, contents string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func gitTest(t *testing.T, root string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = root
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}
