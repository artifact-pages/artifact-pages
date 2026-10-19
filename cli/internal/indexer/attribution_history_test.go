package indexer

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func commitWithGitDates(t testing.TB, root, message, authorName, authorEmail, committerName, committerEmail string, authorDate, committerDate time.Time, trailers ...string) string {
	t.Helper()
	runGit(t, root, "add", "--all")
	args := []string{"commit", "--quiet", "-m", message}
	for _, trailer := range trailers {
		args = append(args, "-m", trailer)
	}
	command := exec.Command("git", args...)
	command.Dir = root
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME="+authorName, "GIT_AUTHOR_EMAIL="+authorEmail,
		"GIT_COMMITTER_NAME="+committerName, "GIT_COMMITTER_EMAIL="+committerEmail,
		"GIT_AUTHOR_DATE="+authorDate.Format(time.RFC3339),
		"GIT_COMMITTER_DATE="+committerDate.Format(time.RFC3339),
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	lookup := exec.Command("git", "rev-parse", "HEAD")
	lookup.Dir = root
	output, err := lookup.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse HEAD: %v\n%s", err, output)
	}
	return strings.TrimSpace(string(output))
}

func mergeWithIdentity(t testing.TB, root, branch, message, authorName, committerName string, timestamp time.Time) {
	t.Helper()
	command := exec.Command("git", "merge", "--no-ff", branch, "-m", message)
	command.Dir = root
	date := timestamp.Format(time.RFC3339)
	command.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME="+authorName, "GIT_AUTHOR_EMAIL=merge-author@example.invalid",
		"GIT_COMMITTER_NAME="+committerName, "GIT_COMMITTER_EMAIL=merge-committer@example.invalid",
		"GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date,
	)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("git merge %s: %v\n%s", branch, err, output)
	}
}

func builtIndexFrom(t testing.TB, root, sourcePath string, options BuildOptions) SiteIndex {
	t.Helper()
	restore := chdirForTest(t, root)
	defer restore()
	options.SiteID = "sre"
	options.SourceDir = sourcePath
	options.OutputDir = filepath.Join(root, ".local", "attribution-test")
	if options.Now == nil {
		options.Now = func() time.Time { return time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC) }
	}
	if _, err := Build(context.Background(), options); err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(options.OutputDir, "_indexes", "sre", "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	var index SiteIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatal(err)
	}
	return index
}

func TestBuildUsesRawAuthorAndCommitterFromSelectedCommit(t *testing.T) {
	root := initializeGitRepository(t)
	writeFixtureFile(t, root, "artifacts/report.html", "<h1>Report</h1>")
	authorDate := time.Date(2027, 2, 1, 1, 2, 3, 0, time.UTC)
	commitDate := time.Date(2026, 2, 1, 4, 5, 6, 0, time.UTC)
	sha := commitWithGitDates(t, root, "publish report", "Alice Example", "alice@example.invalid", "GitHub", "web-flow@example.invalid", authorDate, commitDate)

	index := builtIndexFrom(t, root, "artifacts", BuildOptions{})
	if len(index.Artifacts) != 1 {
		t.Fatalf("artifacts = %d", len(index.Artifacts))
	}
	entry := index.Artifacts[0]
	if entry.LastAuthor == nil || entry.LastAuthor.Name != "Alice Example" || entry.LastAuthor.CommitSHA != sha {
		t.Fatalf("lastAuthor = %+v, want raw Git author and selected full SHA %s", entry.LastAuthor, sha)
	}
	if entry.LastCommitter == nil || entry.LastCommitter.Name != "GitHub" {
		t.Fatalf("lastCommitter = %+v, want raw Git committer", entry.LastCommitter)
	}
	if entry.UpdatedAt != commitDate.Format(time.RFC3339) {
		t.Fatalf("updatedAt = %q, want committer timestamp %s, independent of later author date", entry.UpdatedAt, commitDate)
	}

	workingTreeTime := commitDate.Add(48 * time.Hour)
	writeFixtureFile(t, root, "artifacts/report.html", "<h1>Edited locally</h1>")
	if err := os.Chtimes(filepath.Join(root, "artifacts/report.html"), workingTreeTime, workingTreeTime); err != nil {
		t.Fatal(err)
	}
	index = builtIndexFrom(t, root, "artifacts", BuildOptions{})
	entry = index.Artifacts[0]
	if entry.UpdatedAt != workingTreeTime.Format(time.RFC3339) || entry.LastAuthor == nil || entry.LastAuthor.Name != "Alice Example" || entry.LastAuthor.CommitSHA != sha || entry.LastCommitter == nil || entry.LastCommitter.Name != "GitHub" {
		t.Fatalf("working-tree edit changed committed attribution or update precedence: %+v", entry)
	}
}

func TestBuildBreaksEqualTimestampTiesBySmallestFullSHA(t *testing.T) {
	root := initializeGitRepository(t)
	writeFixtureFile(t, root, "artifacts/report.html", "<h1>Initial</h1>")
	commitWithGitDates(t, root, "initial", "Initial Author", "initial@example.invalid", "Initial Committer", "initial-committer@example.invalid", time.Unix(100, 0).UTC(), time.Unix(100, 0).UTC())
	writeFixtureFile(t, root, "artifacts/report.html", "<h1>First candidate</h1>")
	first := commitWithGitDates(t, root, "first candidate", "First Author", "first@example.invalid", "First Committer", "first-committer@example.invalid", time.Unix(200, 0).UTC(), time.Unix(300, 0).UTC())
	writeFixtureFile(t, root, "artifacts/report.html", "<h1>Second candidate</h1>")
	second := commitWithGitDates(t, root, "second candidate", "Second Author", "second@example.invalid", "Second Committer", "second-committer@example.invalid", time.Unix(500, 0).UTC(), time.Unix(300, 0).UTC())
	winner, author, committer := first, "First Author", "First Committer"
	if second < first {
		winner, author, committer = second, "Second Author", "Second Committer"
	}
	entry := builtIndexFrom(t, root, "artifacts", BuildOptions{}).Artifacts[0]
	if entry.LastAuthor == nil || entry.LastAuthor.CommitSHA != winner || entry.LastAuthor.Name != author || entry.LastCommitter == nil || entry.LastCommitter.Name != committer || entry.UpdatedAt != time.Unix(300, 0).UTC().Format(time.RFC3339) {
		t.Fatalf("equal timestamp winner = %+v; first=%s second=%s", entry, first, second)
	}
}

func TestBuildAttributesFirstParentMergeChangesAndConflictResolution(t *testing.T) {
	t.Run("first-parent merge change", func(t *testing.T) {
		root := initializeGitRepository(t)
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Base</h1>")
		commitWithGitDates(t, root, "base", "Base Author", "base@example.invalid", "Base Committer", "base-committer@example.invalid", time.Unix(10, 0).UTC(), time.Unix(10, 0).UTC())
		runGit(t, root, "checkout", "-b", "feature")
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Feature</h1>")
		commitWithGitDates(t, root, "feature change", "Feature Author", "feature@example.invalid", "Feature Committer", "feature-committer@example.invalid", time.Unix(20, 0).UTC(), time.Unix(20, 0).UTC())
		runGit(t, root, "checkout", "main")
		writeFixtureFile(t, root, "outside.txt", "main branch diverged\n")
		commitWithGitDates(t, root, "main divergence", "Main Author", "main@example.invalid", "Main Committer", "main-committer@example.invalid", time.Unix(30, 0).UTC(), time.Unix(30, 0).UTC())
		mergeTime := time.Unix(40, 0).UTC()
		mergeWithIdentity(t, root, "feature", "merge feature", "Merge Author", "GitHub", mergeTime)
		sha := gitOutputForTest(t, root, "rev-parse", "HEAD")
		entry := builtIndexFrom(t, root, "artifacts", BuildOptions{}).Artifacts[0]
		if entry.LastAuthor == nil || entry.LastAuthor.Name != "Merge Author" || entry.LastAuthor.CommitSHA != sha || entry.LastCommitter == nil || entry.LastCommitter.Name != "GitHub" || entry.UpdatedAt != mergeTime.Format(time.RFC3339) {
			t.Fatalf("first-parent merge attribution = %+v, want merge commit %s", entry, sha)
		}
	})

	t.Run("merge conflict resolution", func(t *testing.T) {
		root := initializeGitRepository(t)
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Base</h1>")
		commitWithGitDates(t, root, "base", "Base", "base@example.invalid", "Base", "base-committer@example.invalid", time.Unix(10, 0).UTC(), time.Unix(10, 0).UTC())
		runGit(t, root, "checkout", "-b", "feature")
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Feature side</h1>")
		commitWithGitDates(t, root, "feature", "Feature", "feature@example.invalid", "Feature", "feature-committer@example.invalid", time.Unix(20, 0).UTC(), time.Unix(20, 0).UTC())
		runGit(t, root, "checkout", "main")
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Main side</h1>")
		commitWithGitDates(t, root, "main", "Main", "main@example.invalid", "Main", "main-committer@example.invalid", time.Unix(30, 0).UTC(), time.Unix(30, 0).UTC())
		command := exec.Command("git", "merge", "--no-ff", "feature", "-m", "conflicting merge")
		command.Dir = root
		conflictAttemptTime := time.Unix(35, 0).UTC().Format(time.RFC3339)
		command.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Conflict Resolver", "GIT_AUTHOR_EMAIL=resolver@example.invalid",
			"GIT_COMMITTER_NAME=GitHub", "GIT_COMMITTER_EMAIL=web-flow@example.invalid",
			"GIT_AUTHOR_DATE="+conflictAttemptTime, "GIT_COMMITTER_DATE="+conflictAttemptTime,
		)
		if output, err := command.CombinedOutput(); err == nil || !strings.Contains(string(output), "CONFLICT") {
			t.Fatalf("expected content conflict, got err=%v output=%s", err, output)
		}
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Resolved by maintainer</h1>")
		mergeTime := time.Unix(40, 0).UTC()
		sha := commitWithGitDates(t, root, "resolve conflict", "Conflict Resolver", "resolver@example.invalid", "GitHub", "web-flow@example.invalid", mergeTime, mergeTime)
		entry := builtIndexFrom(t, root, "artifacts", BuildOptions{}).Artifacts[0]
		if entry.LastAuthor == nil || entry.LastAuthor.Name != "Conflict Resolver" || entry.LastAuthor.CommitSHA != sha || entry.LastCommitter == nil || entry.LastCommitter.Name != "GitHub" {
			t.Fatalf("conflict resolution attribution = %+v, want merge author and committer", entry)
		}
	})

	t.Run("empty first-parent merge contributes nothing", func(t *testing.T) {
		root := initializeGitRepository(t)
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Report</h1>")
		writeFixtureFile(t, root, "artifacts/assets/style.css", "body{color:red}\n")
		commitWithGitDates(t, root, "base", "Base", "base@example.invalid", "Base", "base-committer@example.invalid", time.Unix(10, 0).UTC(), time.Unix(10, 0).UTC())
		runGit(t, root, "checkout", "-b", "feature")
		writeFixtureFile(t, root, "artifacts/assets/style.css", "body{color:blue}\n")
		commitWithGitDates(t, root, "feature resource", "Feature", "feature@example.invalid", "Feature", "feature-committer@example.invalid", time.Unix(20, 0).UTC(), time.Unix(20, 0).UTC())
		runGit(t, root, "checkout", "main")
		writeFixtureFile(t, root, "artifacts/assets/style.css", "body{color:blue}\n")
		mainSHA := commitWithGitDates(t, root, "main resource", "Main", "main@example.invalid", "Main", "main-committer@example.invalid", time.Unix(30, 0).UTC(), time.Unix(30, 0).UTC())
		mergeWithIdentity(t, root, "feature", "empty merge", "Empty Merge Author", "GitHub", time.Unix(40, 0).UTC())
		if len(gitOutputForTest(t, root, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD^1", "HEAD")) != 0 {
			t.Fatal("test merge unexpectedly changes the tree against its first parent")
		}
		entry := builtIndexFrom(t, root, "artifacts", BuildOptions{}).Artifacts[0]
		if entry.LastAuthor == nil || entry.LastAuthor.Name != "Main" || entry.LastAuthor.CommitSHA != mainSHA || entry.LastCommitter == nil || entry.LastCommitter.Name != "Main" || entry.UpdatedAt != time.Unix(30, 0).UTC().Format(time.RFC3339) {
			t.Fatalf("empty merge changed attribution: %+v", entry)
		}
	})
}

func TestArtifactGitHistoryHeaderWithoutTrailingNewline(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	header := []byte("1792497600\x1fGitHub\x1fMerge Author\x1f" + sha)
	timestamp, committer, author, gotSHA, ok := parseArtifactGitHistoryHeader(header)
	if !ok || timestamp.Unix() != 1792497600 || committer != "GitHub" || author != "Merge Author" || gotSHA != sha {
		t.Fatalf("parsed terminal history header = %v, %q, %q, %q, %t", timestamp, committer, author, gotSHA, ok)
	}
}

func TestBuildKeepsPrimaryAuthorsForSquashRebaseCoauthorAndBotCommits(t *testing.T) {
	t.Run("squash primary author", func(t *testing.T) {
		root := initializeGitRepository(t)
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Squashed</h1>")
		sha := commitWithGitDates(t, root, "squash! topic", "Squash Author", "squash@example.invalid", "GitHub", "web-flow@example.invalid", time.Unix(10, 0).UTC(), time.Unix(20, 0).UTC())
		entry := builtIndexFrom(t, root, "artifacts", BuildOptions{}).Artifacts[0]
		if entry.LastAuthor == nil || entry.LastAuthor.Name != "Squash Author" || entry.LastAuthor.CommitSHA != sha || entry.LastCommitter == nil || entry.LastCommitter.Name != "GitHub" {
			t.Fatalf("squash attribution = %+v", entry)
		}
	})

	t.Run("rebase keeps recorded Git author", func(t *testing.T) {
		root := initializeGitRepository(t)
		runGit(t, root, "config", "user.name", "Rebaser")
		runGit(t, root, "config", "user.email", "rebaser@example.invalid")
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Base</h1>")
		commitWithGitDates(t, root, "base", "Base", "base@example.invalid", "Base", "base-committer@example.invalid", time.Unix(10, 0).UTC(), time.Unix(10, 0).UTC())
		runGit(t, root, "checkout", "-b", "feature")
		writeFixtureFile(t, root, "artifacts/report.html", "<h1>Feature</h1>")
		commitWithGitDates(t, root, "feature", "Rebased Author", "author@example.invalid", "Original Committer", "original-committer@example.invalid", time.Unix(20, 0).UTC(), time.Unix(20, 0).UTC())
		runGit(t, root, "checkout", "main")
		writeFixtureFile(t, root, "outside.txt", "main moved\n")
		commitWithGitDates(t, root, "main move", "Main", "main@example.invalid", "Main", "main-committer@example.invalid", time.Unix(30, 0).UTC(), time.Unix(30, 0).UTC())
		runGit(t, root, "checkout", "feature")
		runGit(t, root, "rebase", "main")
		sha := gitOutputForTest(t, root, "rev-parse", "HEAD")
		entry := builtIndexFrom(t, root, "artifacts", BuildOptions{}).Artifacts[0]
		if entry.LastAuthor == nil || entry.LastAuthor.Name != "Rebased Author" || entry.LastAuthor.CommitSHA != sha || entry.LastCommitter == nil || entry.LastCommitter.Name != "Rebaser" {
			t.Fatalf("rebased attribution = %+v", entry)
		}
	})

	t.Run("coauthor trailer ignored and bot retained", func(t *testing.T) {
		root := initializeGitRepository(t)
		writeFixtureFile(t, root, "artifacts/coauthored.html", "<h1>Shared work</h1>")
		commitWithGitDates(t, root, "primary author", "Primary Author", "primary@example.invalid", "Committer", "committer@example.invalid", time.Unix(10, 0).UTC(), time.Unix(10, 0).UTC(), "Co-authored-by: Secondary Author <secondary@example.invalid>")
		writeFixtureFile(t, root, "artifacts/bot.html", "<h1>Automated report</h1>")
		botSHA := commitWithGitDates(t, root, "automated report", "dependabot[bot]", "bot@example.invalid", "GitHub", "web-flow@example.invalid", time.Unix(20, 0).UTC(), time.Unix(20, 0).UTC())
		index := builtIndexFrom(t, root, "artifacts", BuildOptions{})
		byPath := map[string]ArtifactIndexEntry{}
		for _, entry := range index.Artifacts {
			byPath[entry.Path] = entry
		}
		if got := byPath["coauthored.html"].LastAuthor; got == nil || got.Name != "Primary Author" {
			t.Fatalf("coauthored attribution = %+v, want primary Git author", got)
		}
		if got := byPath["bot.html"].LastAuthor; got == nil || got.Name != "dependabot[bot]" || got.CommitSHA != botSHA {
			t.Fatalf("bot attribution = %+v, want bot author unchanged", got)
		}
	})
}
