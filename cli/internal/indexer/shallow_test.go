package indexer

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type shallowMetadata struct {
	UpdatedAt time.Time
	Committer string
}

func shallowTestTime(day int) time.Time {
	return time.Date(2026, 1, day, 12, 0, 0, 0, time.UTC)
}

func shallowCommit(t *testing.T, root, name string, day int) {
	t.Helper()
	commitFixtureWithIdentities(t, root, "change by "+name, shallowTestTime(day), name, name+"@example.invalid", name, name+"@example.invalid")
}

func shallowFiller(t *testing.T, root string, count, firstDay int) {
	t.Helper()
	for index := 0; index < count; index++ {
		writeFixtureFile(t, root, "other/filler.txt", fmt.Sprintf("filler %d-%d\n", firstDay, index))
		shallowCommit(t, root, "Filler", firstDay+index)
	}
}

func gitOutputForTest(t *testing.T, directory string, args ...string) string {
	t.Helper()
	command := exec.Command("git", args...)
	command.Dir = directory
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func cloneForShallowTest(t *testing.T, origin string, depth int) string {
	t.Helper()
	destination := filepath.Join(t.TempDir(), "clone")
	args := []string{"clone", "--quiet", "--no-local"}
	if depth > 0 {
		args = append(args, fmt.Sprintf("--depth=%d", depth))
	}
	args = append(args, "file://"+origin, destination)
	gitOutputForTest(t, ".", args...)
	return destination
}

func prepareMetadata(t *testing.T, root string, loader PriorStateLoader) map[string]shallowMetadata {
	t.Helper()
	restore := chdirForTest(t, root)
	defer restore()
	prepared, err := PrepareBuild(context.Background(), BuildOptions{
		SiteID: "notes", SourceDir: "content", OutputDir: ".local/out", RejectSymlinks: true,
		Now: func() time.Time { return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) }, PriorState: loader,
	})
	if err != nil {
		t.Fatalf("PrepareBuild(%s) error = %v", root, err)
	}
	result := make(map[string]shallowMetadata)
	for _, document := range prepared.documents {
		result[document.artifact.relative] = shallowMetadata{document.updatedAt, document.lastCommitter}
	}
	return result
}

// priorFromOrigin models the deployed state: metadata and file hashes as a
// full clone of origin produced them at the time of the last publish.
func priorFromOrigin(t *testing.T, origin string) PriorStateLoader {
	t.Helper()
	restore := chdirForTest(t, origin)
	defer restore()
	prepared, err := PrepareBuild(context.Background(), BuildOptions{
		SiteID: "notes", SourceDir: "content", OutputDir: ".local/out", RejectSymlinks: true,
		Now: func() time.Time { return time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("PrepareBuild(prior) error = %v", err)
	}
	prior := &PriorSiteState{Files: map[string]string{}, Documents: map[string]PriorDocument{}}
	for _, file := range prepared.files {
		prior.Files[file.RelativePath] = file.SHA256
	}
	for _, document := range prepared.documents {
		prior.Documents[document.artifact.relative] = PriorDocument{UpdatedAt: document.updatedAt, LastCommitter: document.lastCommitter}
	}
	return func(context.Context) (*PriorSiteState, error) { return prior, nil }
}

func seedShallowOrigin(t *testing.T) string {
	t.Helper()
	origin := initializeGitRepository(t)
	gitOutputForTest(t, origin, "config", "user.email", "t@example.invalid")
	gitOutputForTest(t, origin, "config", "user.name", "T")
	writeFixtureFile(t, origin, "content/a.md", "# A\n")
	writeFixtureFile(t, origin, "content/b.md", "# B\n")
	writeFixtureFile(t, origin, "content/c.md", "# C\n")
	writeFixtureFile(t, origin, "content/guide/index.html", "<title>Guide</title><link rel=stylesheet href=style.css>")
	writeFixtureFile(t, origin, "content/guide/style.css", "body{color:red}\n")
	shallowCommit(t, origin, "Alice", 1)
	writeFixtureFile(t, origin, "content/b.md", "# B2\n")
	shallowCommit(t, origin, "Bob", 2)
	writeFixtureFile(t, origin, "content/guide/style.css", "body{color:blue}\n")
	shallowCommit(t, origin, "Carol", 3)
	return origin
}

func assertShallowEqualsFull(t *testing.T, origin string, depth int, loader PriorStateLoader) (string, map[string]shallowMetadata) {
	t.Helper()
	full := prepareMetadata(t, cloneForShallowTest(t, origin, 0), nil)
	shallowClone := cloneForShallowTest(t, origin, depth)
	if got := gitOutputForTest(t, shallowClone, "rev-parse", "--is-shallow-repository"); got != "true" {
		t.Fatalf("test clone shallow = %s", got)
	}
	shallow := prepareMetadata(t, shallowClone, loader)
	if len(shallow) != len(full) {
		t.Fatalf("shallow documents = %v, full = %v", shallow, full)
	}
	for path, want := range full {
		if got := shallow[path]; got != want {
			t.Errorf("%s: shallow metadata = %+v, full clone = %+v", path, got, want)
		}
	}
	return shallowClone, shallow
}

func commitCount(t *testing.T, root string) int {
	t.Helper()
	var count int
	fmt.Sscan(gitOutputForTest(t, root, "rev-list", "--count", "HEAD"), &count)
	return count
}

func TestShallowCarryForwardMatchesFullCloneWithoutFetchingAllHistory(t *testing.T) {
	origin := seedShallowOrigin(t)
	prior := priorFromOrigin(t, origin)
	shallowFiller(t, origin, 10, 4)
	writeFixtureFile(t, origin, "content/a.md", "# A2\n")
	shallowCommit(t, origin, "Dave", 15)
	writeFixtureFile(t, origin, "content/guide/style.css", "body{color:green}\n") // shared resource
	shallowCommit(t, origin, "Erin", 16)
	writeFixtureFile(t, origin, "content/a.md", "# A3\n")
	writeFixtureFile(t, origin, "content/d.md", "# D\n")
	shallowCommit(t, origin, "Frank", 17)

	clone, shallow := assertShallowEqualsFull(t, origin, 1, prior)
	if shallow["a.md"].Committer != "Frank" || shallow["d.md"].Committer != "Frank" || shallow["guide/index.html"].Committer != "Erin" {
		t.Fatalf("unexpected changed-document metadata: %+v", shallow)
	}
	if shallow["b.md"].Committer != "Bob" || shallow["c.md"].Committer != "Alice" {
		t.Fatalf("unchanged documents = %+v / %+v, want carried-forward Bob / Alice", shallow["b.md"], shallow["c.md"])
	}
	if got, total := commitCount(t, clone), commitCount(t, origin); got >= total {
		t.Fatalf("shallow clone fetched %d of %d commits; carry-forward should avoid full history", got, total)
	}
	if gitOutputForTest(t, clone, "rev-parse", "--is-shallow-repository") != "true" {
		t.Fatal("clone was fully unshallowed although deployed state covers the unchanged documents")
	}
}

func TestShallowDeepensRepeatedlyForOldChangedDocument(t *testing.T) {
	origin := seedShallowOrigin(t)
	prior := priorFromOrigin(t, origin)
	writeFixtureFile(t, origin, "content/a.md", "# A2\n")
	shallowCommit(t, origin, "Dave", 4)
	shallowFiller(t, origin, 40, 5) // pushes the last touching commit past two deepen steps
	clone, shallow := assertShallowEqualsFull(t, origin, 1, prior)
	if shallow["a.md"].Committer != "Dave" {
		t.Fatalf("a.md = %+v, want Dave", shallow["a.md"])
	}
	if commitCount(t, clone) <= 9 {
		t.Fatal("a single deepen step cannot reach the touching commit; deepening should have repeated")
	}
}

func TestShallowWithoutTrustworthyPriorStateUnshallows(t *testing.T) {
	for name, loader := range map[string]PriorStateLoader{
		"no loader":     nil,
		"first publish": func(context.Context) (*PriorSiteState, error) { return nil, nil },
	} {
		t.Run(name, func(t *testing.T) {
			origin := seedShallowOrigin(t)
			shallowFiller(t, origin, 12, 4)
			clone, _ := assertShallowEqualsFull(t, origin, 1, loader)
			if gitOutputForTest(t, clone, "rev-parse", "--is-shallow-repository") != "false" {
				t.Fatal("checkout should have been unshallowed")
			}
		})
	}
}

func TestShallowRevertToIdenticalBytesUsesVisibleNewerCommit(t *testing.T) {
	origin := seedShallowOrigin(t)
	prior := priorFromOrigin(t, origin)
	writeFixtureFile(t, origin, "content/b.md", "# B changed\n")
	shallowCommit(t, origin, "Dave", 4)
	writeFixtureFile(t, origin, "content/b.md", "# B2\n") // back to the deployed bytes
	shallowCommit(t, origin, "Erin", 5)
	_, shallow := assertShallowEqualsFull(t, origin, 3, prior)
	if shallow["b.md"].Committer != "Erin" {
		t.Fatalf("b.md = %+v, want the newer visible revert commit", shallow["b.md"])
	}
}

func TestShallowUntrackedDocumentKeepsFilesystemFallback(t *testing.T) {
	origin := seedShallowOrigin(t)
	prior := priorFromOrigin(t, origin)
	shallowFiller(t, origin, 3, 4)
	clone := cloneForShallowTest(t, origin, 1)
	writeFixtureFile(t, clone, "content/local.md", "# Untracked\n")
	got := prepareMetadata(t, clone, prior)
	if entry := got["local.md"]; entry.Committer != "" || entry.UpdatedAt.IsZero() {
		t.Fatalf("local.md = %+v, want filesystem timestamp and no committer", entry)
	}
}

func TestShallowDocumentScopeDigestTracksNestedResourcesAndLayout(t *testing.T) {
	files := map[string]string{"a.md": "h1", "guide/index.html": "h2", "guide/style.css": "h3", "guide/img/x.png": "h4"}
	base := documentScopeDigests([]string{"a.md", "guide/index.html"}, files)
	changed := map[string]string{"a.md": "h1", "guide/index.html": "h2", "guide/style.css": "hX", "guide/img/x.png": "h4"}
	next := documentScopeDigests([]string{"a.md", "guide/index.html"}, changed)
	if base["guide/index.html"] == next["guide/index.html"] || base["a.md"] != next["a.md"] {
		t.Fatalf("nested resource change must affect only its owning document: %v vs %v", base, next)
	}
	// A new document in the nested directory takes ownership of its resources.
	layout := documentScopeDigests([]string{"a.md", "guide/index.html", "guide/img/p.md"}, files)
	if layout["guide/index.html"] == base["guide/index.html"] {
		t.Fatal("document layout change must invalidate carried metadata")
	}
}

func TestShallowRemovedDocumentInvalidatesRollupWithoutOtherChanges(t *testing.T) {
	origin := seedShallowOrigin(t)
	prior := priorFromOrigin(t, origin)
	shallowFiller(t, origin, 10, 4)
	gitOutputForTest(t, origin, "rm", "-q", "content/c.md") // only a deletion at HEAD
	shallowCommit(t, origin, "Gina", 20)
	_, shallow := assertShallowEqualsFull(t, origin, 1, prior)
	if shallow["a.md"].Committer != "Gina" {
		t.Fatalf("a.md = %+v, want the deletion commit to roll up into root documents", shallow["a.md"])
	}
}

func TestShallowRenamedDocumentMatchesFullClone(t *testing.T) {
	origin := seedShallowOrigin(t)
	prior := priorFromOrigin(t, origin)
	shallowFiller(t, origin, 10, 4)
	gitOutputForTest(t, origin, "mv", "content/c.md", "content/c-renamed.md")
	shallowCommit(t, origin, "Gina", 20)
	_, shallow := assertShallowEqualsFull(t, origin, 1, prior)
	if shallow["c-renamed.md"].Committer != "Gina" {
		t.Fatalf("c-renamed.md = %+v", shallow["c-renamed.md"])
	}
}
