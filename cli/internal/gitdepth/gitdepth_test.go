package gitdepth

import (
	"context"
	"encoding/base64"
	"fmt"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	command := exec.Command("git", append([]string{"-c", "user.name=T", "-c", "user.email=t@example.invalid"}, args...)...)
	command.Dir = dir
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return strings.TrimSpace(string(output))
}

func commit(t *testing.T, dir, name string) {
	t.Helper()
	git(t, dir, "commit", "--quiet", "--allow-empty", "-m", name)
}

func TestAuthEnvInjectsTokenOnlyForGitHubHTTPSWithoutExistingHeader(t *testing.T) {
	base := []string{"PATH=/bin", "GITHUB_TOKEN=secret-token"}
	env, secrets := AuthEnv(base, "https://github.com/acme/repo.git", false)
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "GIT_CONFIG_COUNT=1") || !strings.Contains(joined, "GIT_CONFIG_KEY_0=http.https://github.com/.extraheader") ||
		!strings.Contains(joined, "GIT_CONFIG_VALUE_0=AUTHORIZATION: basic ") || strings.Contains(joined, "GIT_CONFIG_VALUE_0=AUTHORIZATION: basic secret-token") {
		t.Fatalf("unexpected env %q", joined)
	}
	if len(secrets) != 2 || secrets[0] != "secret-token" {
		t.Fatalf("secrets = %v", secrets)
	}
	for name, input := range map[string][]string{
		"existing header": nil, "other host": nil, "ssh remote": nil, "no token": nil,
	} {
		_ = input
		var got []string
		switch name {
		case "existing header":
			got, _ = AuthEnv(base, "https://github.com/acme/repo", true)
		case "other host":
			got, _ = AuthEnv(base, "https://git.example.com/acme/repo", false)
		case "ssh remote":
			got, _ = AuthEnv(base, "git@github.com:acme/repo.git", false)
		case "no token":
			got, _ = AuthEnv([]string{"PATH=/bin"}, "https://github.com/acme/repo", false)
		}
		if strings.Contains(strings.Join(got, "\n"), "GIT_CONFIG_COUNT") {
			t.Errorf("%s: header must not be injected, got %v", name, got)
		}
	}
	enterprise, _ := AuthEnv([]string{"GH_TOKEN=t", "GITHUB_SERVER_URL=https://ghe.example.com"}, "https://ghe.example.com/acme/repo", false)
	if !strings.Contains(strings.Join(enterprise, "\n"), "GIT_CONFIG_KEY_0=http.https://ghe.example.com/.extraheader") {
		t.Fatalf("GH_TOKEN with the workflow's server host should authenticate: %v", enterprise)
	}
	appended, _ := AuthEnv([]string{"GITHUB_TOKEN=t", "GIT_CONFIG_COUNT=2"}, "https://github.com/a/b", false)
	if joined := strings.Join(appended, "\n"); !strings.Contains(joined, "GIT_CONFIG_COUNT=3") || !strings.Contains(joined, "GIT_CONFIG_KEY_2=") {
		t.Fatalf("existing GIT_CONFIG entries must be preserved: %v", appended)
	}
	if got := redact("fatal: token secret-token leaked", secrets); strings.Contains(got, "secret-token") {
		t.Fatalf("redact() = %q", got)
	}
}

// historyWithMerge builds main with a long first-parent line and a feature
// branch that merged main twice. It returns origin and the two tip SHAs.
func historyWithMerge(t *testing.T) (origin, mainTip, featureTip string) {
	t.Helper()
	origin = t.TempDir()
	git(t, origin, "init", "--quiet", "-b", "main")
	for index := 0; index < 100; index++ {
		commit(t, origin, fmt.Sprintf("main-%d", index))
	}
	git(t, origin, "checkout", "--quiet", "-b", "feature")
	commit(t, origin, "f1")
	git(t, origin, "checkout", "--quiet", "main")
	for index := 100; index < 120; index++ {
		commit(t, origin, fmt.Sprintf("main-%d", index))
	}
	git(t, origin, "checkout", "--quiet", "feature")
	git(t, origin, "merge", "--quiet", "--no-ff", "-m", "merge main", "main")
	commit(t, origin, "f2")
	git(t, origin, "checkout", "--quiet", "main")
	for index := 120; index < 130; index++ {
		commit(t, origin, fmt.Sprintf("main-%d", index))
	}
	return origin, git(t, origin, "rev-parse", "main"), git(t, origin, "rev-parse", "feature")
}

func TestEnsureMergeBaseDeepensToTheExactMergeBase(t *testing.T) {
	origin, mainTip, featureTip := historyWithMerge(t)
	want := git(t, origin, "merge-base", mainTip, featureTip)
	clone := filepath.Join(t.TempDir(), "clone")
	git(t, ".", "clone", "--quiet", "--no-local", "--depth=1", "--branch", "feature", "file://"+origin, clone)
	if err := FetchShallowRef(context.Background(), clone, mainTip); err != nil {
		t.Fatal(err)
	}
	if shallow, _ := IsShallow(context.Background(), clone); !shallow {
		t.Fatal("clone should be shallow")
	}
	got, err := EnsureMergeBase(context.Background(), clone, mainTip, featureTip)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("shallow merge-base = %s, full-history merge-base = %s", got, want)
	}
	count := git(t, clone, "rev-list", "--count", mainTip)
	if count == git(t, origin, "rev-list", "--count", mainTip) {
		t.Fatal("merge-base resolution should not need the full history of main")
	}
}

func TestEnsureMergeBaseUnrelatedHistoriesFailsAfterUnshallow(t *testing.T) {
	origin := t.TempDir()
	git(t, origin, "init", "--quiet", "-b", "main")
	commit(t, origin, "a")
	git(t, origin, "checkout", "--quiet", "--orphan", "other")
	commit(t, origin, "b")
	clone := filepath.Join(t.TempDir(), "clone")
	git(t, ".", "clone", "--quiet", "--no-local", "--depth=1", "--branch", "other", "file://"+origin, clone)
	mainTip := git(t, origin, "rev-parse", "main")
	if err := FetchShallowRef(context.Background(), clone, mainTip); err != nil {
		t.Fatal(err)
	}
	_, err := EnsureMergeBase(context.Background(), clone, mainTip, git(t, clone, "rev-parse", "HEAD"))
	if err == nil || !strings.Contains(err.Error(), "no merge base") {
		t.Fatalf("error = %v, want no merge base", err)
	}
}

func TestFetchFailureIsActionableAndRedacted(t *testing.T) {
	origin := t.TempDir()
	git(t, origin, "init", "--quiet", "-b", "main")
	commit(t, origin, "a")
	commit(t, origin, "b")
	clone := filepath.Join(t.TempDir(), "clone")
	git(t, ".", "clone", "--quiet", "--no-local", "--depth=1", "file://"+origin, clone)
	git(t, clone, "remote", "set-url", "origin", "file:///nonexistent/repository")
	err := Deepen(context.Background(), clone, 1, git(t, clone, "rev-parse", "HEAD"))
	if err == nil || !strings.Contains(err.Error(), "fetch-depth: 0") {
		t.Fatalf("error = %v, want guidance naming fetch-depth: 0", err)
	}
}

func TestAuthEnvPrefersTheDedicatedFetchToken(t *testing.T) {
	env, secrets := AuthEnv([]string{"GITHUB_TOKEN=config-repo-token", "ARTIFACT_PAGES_FETCH_TOKEN=workflow-token"}, "https://github.com/acme/repo", false)
	if len(secrets) != 2 || secrets[0] != "workflow-token" {
		t.Fatalf("fetch token should win, secrets = %v", secrets)
	}
	want := "AUTHORIZATION: basic " + base64.StdEncoding.EncodeToString([]byte("x-access-token:workflow-token"))
	if !strings.Contains(strings.Join(env, "\n"), "GIT_CONFIG_VALUE_0="+want) {
		t.Fatalf("header should carry the fetch token: %v", env)
	}
}

func TestEnsureMergeBaseToleratesAHeadThatOriginDoesNotHave(t *testing.T) {
	origin, mainTip, featureTip := historyWithMerge(t)
	want := git(t, origin, "merge-base", mainTip, featureTip)
	clone := filepath.Join(t.TempDir(), "clone")
	git(t, ".", "clone", "--quiet", "--no-local", "--depth=1", "--branch", "feature", "file://"+origin, clone)
	if err := FetchShallowRef(context.Background(), clone, mainTip); err != nil {
		t.Fatal(err)
	}
	commit(t, clone, "local only")
	localHead := git(t, clone, "rev-parse", "HEAD")
	got, err := EnsureMergeBase(context.Background(), clone, mainTip, localHead)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("merge-base with a local-only head = %s, want %s", got, want)
	}
}
