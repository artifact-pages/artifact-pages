package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func trustedGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", append([]string{"-C", dir}, args...)...)
	b, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, b)
	}
	return strings.TrimSpace(string(b))
}
func trustedFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	trustedGit(t, root, "init", "-b", "main")
	trustedGit(t, root, "config", "user.name", "Test")
	trustedGit(t, root, "config", "user.email", "test@example.com")
	os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte("schemaVersion: 1\nprovider: local\nlocal: {root: .local}\ncli: {version: 0.1.0}\n"), 0600)
	os.WriteFile(filepath.Join(root, "other.yaml"), []byte("schemaVersion: 1\nfuture: trusted\n"), 0600)
	trustedGit(t, root, "add", ".")
	trustedGit(t, root, "commit", "-m", "base")
	return root, trustedGit(t, root, "rev-parse", "HEAD")
}
func TestTrustedConfigNeverReadsPRHeadAndUsesBaseDefaultDiscovery(t *testing.T) {
	root, base := trustedFixture(t)
	r := Resolver{WorkingDir: root, ConfigDir: t.TempDir(), Getenv: func(k string) string {
		if k == TrustedConfigRefEnvironment {
			return base
		}
		return ""
	}}
	os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte("schemaVersion: 999\ncli: {version: 9.9.9}\n"), 0600)
	v, err := r.ResolveCLIVersion(t.Context(), nil)
	if err != nil || v != "0.1.0" {
		t.Fatal(v, err)
	}
	strict, err := r.ResolveLayers(t.Context(), nil)
	if err != nil || strict.Config.CLI.Version != "0.1.0" {
		t.Fatal(strict, err)
	}
	os.Remove(filepath.Join(root, "artifact-pages.yaml"))
	v, err = r.ResolveCLIVersion(t.Context(), nil)
	if err != nil || v != "0.1.0" {
		t.Fatal(v, err)
	}
	external := filepath.Join(t.TempDir(), "operator.yaml")
	os.WriteFile(external, []byte("schemaVersion: 999\ncli: {version: 0.1.8}\n"), 0600)
	v, err = r.ResolveCLIVersion(t.Context(), []string{external})
	if err != nil || v != "0.1.8" {
		t.Fatal(v, err)
	}
	os.Symlink(external, filepath.Join(root, "head-link.yaml"))
	if _, err = r.ResolveCLIVersion(t.Context(), []string{"head-link.yaml"}); err == nil {
		t.Fatal("repo symlink escaped trust boundary")
	}
	os.WriteFile(filepath.Join(root, "added.yaml"), []byte("cli: {version: 0.1.7}"), 0600)
	if _, err = r.ResolveCLIVersion(t.Context(), []string{"added.yaml"}); err == nil {
		t.Fatal("PR-added config selected a version")
	}
	// An outside alias into the checkout still selects base bytes.
	os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte("cli: {version: 9.9.9}"), 0600)
	alias := filepath.Join(t.TempDir(), "alias.yaml")
	os.Symlink(filepath.Join(root, "artifact-pages.yaml"), alias)
	v, err = r.ResolveCLIVersion(t.Context(), []string{alias})
	if err != nil || v != "0.1.0" {
		t.Fatal(v, err)
	}
	v, err = r.ResolveCLIVersion(t.Context(), []string{"other.yaml", "artifact-pages.yaml"})
	if err != nil || v != "0.1.0" {
		t.Fatal(v, err)
	}
}
func TestTrustedBaseRejectsSymlinkAndHeadOnlyDefault(t *testing.T) {
	root, base := trustedFixture(t)
	os.Symlink("artifact-pages.yaml", filepath.Join(root, "linked.yaml"))
	trustedGit(t, root, "add", "linked.yaml")
	trustedGit(t, root, "commit", "-m", "symlink")
	base = trustedGit(t, root, "rev-parse", "HEAD")
	r := Resolver{WorkingDir: root, ConfigDir: t.TempDir(), Getenv: func(k string) string {
		if k == TrustedConfigRefEnvironment {
			return base
		}
		return ""
	}}
	if _, err := r.ResolveCLIVersion(t.Context(), []string{"linked.yaml"}); err == nil || !strings.Contains(err.Error(), "regular tracked") {
		t.Fatal(err)
	}
	trustedGit(t, root, "rm", "artifact-pages.yaml", "linked.yaml")
	trustedGit(t, root, "commit", "-m", "remove default")
	base = trustedGit(t, root, "rev-parse", "HEAD")
	os.WriteFile(filepath.Join(root, "artifact-pages.yaml"), []byte("cli: {version: 9.9.9}"), 0600)
	if _, err := r.ResolveCLIVersion(t.Context(), nil); err == nil || !strings.Contains(err.Error(), "no deployment config") {
		t.Fatal(err)
	}
}
func TestTrustedConfigFetchesExactMissingBaseInShallowCheckout(t *testing.T) {
	origin, base := trustedFixture(t)
	os.WriteFile(filepath.Join(origin, "artifact-pages.yaml"), []byte("cli: {version: 0.1.9}"), 0600)
	trustedGit(t, origin, "add", ".")
	trustedGit(t, origin, "commit", "-m", "head")
	clone := filepath.Join(t.TempDir(), "checkout")
	c := exec.Command("git", "clone", "--depth=1", "file://"+origin, clone)
	if b, err := c.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, b)
	}
	r := Resolver{WorkingDir: clone, Getenv: func(k string) string {
		if k == TrustedConfigRefEnvironment {
			return base
		}
		return ""
	}}
	v, err := r.ResolveCLIVersion(t.Context(), nil)
	if err != nil || v != "0.1.0" {
		t.Fatal(v, err)
	}
}

func TestTrustedBaseFetchSeparatesPrivateConfigTokenAndPreservesCheckoutHeader(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(strings.ToLower(strings.TrimSpace(map[bool]string{false: "new auth", true: "existing checkout auth"}[existing])), func(t *testing.T) {
			dir := t.TempDir()
			capture := filepath.Join(dir, "fetch.env")
			done := filepath.Join(dir, "done")
			script := `#!/bin/sh
case "$*" in
 *cat-file*) test -f "$FETCH_DONE"; exit $? ;;
 *get-urlmatch*) if test "$EXISTING_HEADER" = 1; then printf 'AUTHORIZATION: basic checkout-header'; fi; exit 0 ;;
 *remote.origin.url*) printf 'https://github.com/acme/site'; exit 0 ;;
 *fetch*) env > "$CAPTURE_FILE"; touch "$FETCH_DONE"; exit 0 ;;
esac
exit 1
`
			os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0700)
			t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("CAPTURE_FILE", capture)
			t.Setenv("FETCH_DONE", done)
			t.Setenv("GITHUB_TOKEN", "private-test-token")
			t.Setenv("GH_TOKEN", "other-private-test-token")
			t.Setenv("ARTIFACT_PAGES_FETCH_TOKEN", "inherited-token")
			header := "0"
			if existing {
				header = "1"
			}
			t.Setenv("EXISTING_HEADER", header)
			r := Resolver{Getenv: func(k string) string {
				if k == "ARTIFACT_PAGES_FETCH_TOKEN" {
					return "workflow-test-token"
				}
				return ""
			}}
			if err := r.ensureTrustedCommit(t.Context(), dir, strings.Repeat("a", 40)); err != nil {
				t.Fatal(err)
			}
			data, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			text := string(data)
			if strings.Contains(text, "private-test-token") || strings.Contains("\n"+text, "\nGITHUB_TOKEN=") || strings.Contains("\n"+text, "\nGH_TOKEN=") || strings.Contains(text, "inherited-token") {
				t.Fatalf("private credential detection: secret=%t githubKey=%t ghKey=%t inherited=%t", strings.Contains(text, "private-test-token"), strings.Contains(text, "GITHUB_TOKEN="), strings.Contains(text, "GH_TOKEN="), strings.Contains(text, "inherited-token"))
			}
			if !strings.Contains(text, "ARTIFACT_PAGES_FETCH_TOKEN=workflow-test-token") {
				t.Fatal("workflow fetch token missing")
			}
			if existing {
				if strings.Contains(text, "http.https://github.com/.extraheader") {
					t.Fatal("existing checkout auth replaced")
				}
			} else if !strings.Contains(text, "http.https://github.com/.extraheader") {
				t.Fatal("one-shot workflow auth missing")
			}
		})
	}
}
