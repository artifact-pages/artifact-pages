package publisher

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func shallowGit(t *testing.T, dir string, env []string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = dir
	command.Env = append(os.Environ(), env...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func shallowCommitAs(t *testing.T, origin, committer string, day int) {
	t.Helper()
	date := time.Date(2026, 2, day, 9, 0, 0, 0, time.UTC).Format(time.RFC3339)
	shallowGit(t, origin, []string{
		"GIT_AUTHOR_NAME=" + committer, "GIT_AUTHOR_EMAIL=a@example.invalid", "GIT_AUTHOR_DATE=" + date,
		"GIT_COMMITTER_NAME=" + committer, "GIT_COMMITTER_EMAIL=a@example.invalid", "GIT_COMMITTER_DATE=" + date,
	}, "add", "--all")
	shallowGit(t, origin, []string{
		"GIT_AUTHOR_NAME=" + committer, "GIT_AUTHOR_EMAIL=a@example.invalid", "GIT_AUTHOR_DATE=" + date,
		"GIT_COMMITTER_NAME=" + committer, "GIT_COMMITTER_EMAIL=a@example.invalid", "GIT_COMMITTER_DATE=" + date,
	}, "commit", "-q", "-m", "by "+committer)
}

func shallowWrite(t *testing.T, root, relative, contents string) {
	t.Helper()
	target := filepath.Join(root, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

// cloneRegistered clones origin (optionally shallow) and makes the checkout
// look like acme/sre while still fetching from the local origin repository.
func cloneRegistered(t *testing.T, origin string, depth int) string {
	t.Helper()
	destination := filepath.Join(t.TempDir(), "checkout")
	args := []string{"clone", "-q", "--no-local"}
	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}
	shallowGit(t, ".", nil, append(args, "file://"+origin, destination)...)
	shallowGit(t, destination, nil, "config", "url.file://"+origin+".insteadOf", "git@github.com:acme/sre.git")
	shallowGit(t, destination, nil, "remote", "set-url", "origin", "git@github.com:acme/sre.git")
	return destination
}

func publishFrom(t *testing.T, checkout string, backend *DirectoryBackend, dryRun bool) Result {
	t.Helper()
	previous, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(checkout); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Chdir(previous) }()
	result, err := PublishSite(t.Context(), backend, SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts", DryRun: dryRun})
	if err != nil {
		t.Fatalf("PublishSite(%s) error = %v", checkout, err)
	}
	return result
}

func newRegisteredBackend(t *testing.T) *DirectoryBackend {
	t.Helper()
	backend, err := NewDirectoryBackend(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	seedDirectoryRegistry(t, backend, registeredSREManifest)
	return backend
}

func publishedProjection(t *testing.T, backend *DirectoryBackend) (inputRoot string, index []byte) {
	t.Helper()
	info, err := backend.HeadObject(t.Context(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	object, _, err := backend.GetObject(t.Context(), "_indexes/sre/index.json")
	if err != nil {
		t.Fatal(err)
	}
	return info.Metadata["artifact-pages-publish-input-root"], object.Bytes
}

func TestPublishSiteFromShallowCloneMatchesFullClone(t *testing.T) {
	origin := t.TempDir()
	shallowGit(t, origin, nil, "init", "-q", "-b", "main")
	shallowGit(t, origin, nil, "config", "user.name", "T")
	shallowGit(t, origin, nil, "config", "user.email", "t@example.invalid")
	shallowWrite(t, origin, "docs/artifacts/a.html", "<title>A</title><link rel=stylesheet href=guide/s.css>")
	shallowWrite(t, origin, "docs/artifacts/b.md", "# B\n")
	shallowWrite(t, origin, "docs/artifacts/guide/index.html", "<title>Guide</title><link rel=stylesheet href=s.css>")
	shallowWrite(t, origin, "docs/artifacts/guide/s.css", "p{color:red}\n")
	shallowCommitAs(t, origin, "Alice", 1)
	shallowWrite(t, origin, "docs/artifacts/b.md", "# B2\n")
	shallowCommitAs(t, origin, "Bob", 2)

	deployed := newRegisteredBackend(t)
	first := publishFrom(t, cloneRegistered(t, origin, 0), deployed, false)
	if first.Outcome != "published" {
		t.Fatalf("initial publish outcome = %q", first.Outcome)
	}

	// Several commits land before the next publish, including a shared resource change.
	for day := 3; day < 13; day++ {
		shallowWrite(t, origin, "elsewhere/n.txt", fmt.Sprintf("%d", day))
		shallowCommitAs(t, origin, "Filler", day)
	}
	shallowWrite(t, origin, "docs/artifacts/guide/s.css", "p{color:blue}\n")
	shallowCommitAs(t, origin, "Carol", 20)
	shallowWrite(t, origin, "docs/artifacts/a.html", "<title>A2</title><link rel=stylesheet href=guide/s.css>")
	shallowCommitAs(t, origin, "Dave", 21)

	fullReference := newRegisteredBackend(t)
	publishFrom(t, cloneRegistered(t, origin, 0), fullReference, false)
	wantRoot, wantIndex := publishedProjection(t, fullReference)

	shallowCheckout := cloneRegistered(t, origin, 1)
	dry := publishFrom(t, shallowCheckout, deployed, true)
	if dry.Outcome != "planned" {
		t.Fatalf("shallow dry-run outcome = %q, want planned", dry.Outcome)
	}
	real := publishFrom(t, shallowCheckout, deployed, false)
	if real.Outcome != "published" {
		t.Fatalf("shallow publish outcome = %q", real.Outcome)
	}
	gotRoot, gotIndex := publishedProjection(t, deployed)
	if gotRoot != wantRoot {
		t.Fatalf("shallow publish input root %s differs from full clone's %s", gotRoot, wantRoot)
	}
	if strings.Contains(string(gotIndex), "Filler") || !strings.Contains(string(gotIndex), "Carol") || !strings.Contains(string(gotIndex), "Dave") {
		t.Fatalf("unexpected deployed metadata: %s", gotIndex)
	}
	_ = wantIndex
	if shallowGit(t, shallowCheckout, nil, "rev-parse", "--is-shallow-repository") != "true" {
		t.Fatal("carry-forward should have avoided unshallowing the checkout")
	}
	if again := publishFrom(t, shallowCheckout, deployed, false); again.Outcome != "no-op" {
		t.Fatalf("repeat shallow publish outcome = %q, want no-op", again.Outcome)
	}
}

func TestPublishSiteFirstPublishFromShallowCloneUnshallows(t *testing.T) {
	origin := t.TempDir()
	shallowGit(t, origin, nil, "init", "-q", "-b", "main")
	shallowGit(t, origin, nil, "config", "user.name", "T")
	shallowGit(t, origin, nil, "config", "user.email", "t@example.invalid")
	shallowWrite(t, origin, "docs/artifacts/a.md", "# A\n")
	shallowCommitAs(t, origin, "Alice", 1)
	shallowWrite(t, origin, "docs/artifacts/b.md", "# B\n")
	shallowCommitAs(t, origin, "Bob", 2)

	reference := newRegisteredBackend(t)
	publishFrom(t, cloneRegistered(t, origin, 0), reference, false)
	wantRoot, _ := publishedProjection(t, reference)

	checkout := cloneRegistered(t, origin, 1)
	fresh := newRegisteredBackend(t)
	publishFrom(t, checkout, fresh, false)
	gotRoot, gotIndex := publishedProjection(t, fresh)
	if gotRoot != wantRoot {
		t.Fatalf("first shallow publish root %s differs from full clone's %s: %s", gotRoot, wantRoot, gotIndex)
	}
	if shallowGit(t, checkout, nil, "rev-parse", "--is-shallow-repository") != "false" {
		t.Fatal("first publish has no deployed state to carry forward and must unshallow")
	}
}
