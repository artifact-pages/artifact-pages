package config

import (
	"context"
	"errors"
	"fmt"
	"github.com/artifact-pages/artifact-pages/cli/internal/gitdepth"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const TrustedConfigRefEnvironment = "ARTIFACT_PAGES_TRUSTED_CONFIG_REF"

func inside(root, p string) bool {
	relative, err := filepath.Rel(root, p)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

// readLocalConfig freezes repository-owned config bytes at the verified preview
// base. Explicit external operator files retain their T10 authority. Lexical
// classification occurs before resolving symlinks so a repository link cannot
// turn a PR-controlled file into an external operator config.
func (r Resolver) readLocalConfig(ctx context.Context, p, workingDir string) ([]byte, error) {
	ref := r.getenv(TrustedConfigRefEnvironment)
	if ref == "" {
		return os.ReadFile(p)
	}
	if !commitPattern.MatchString(ref) {
		return nil, errors.New("trusted config ref must be a full commit SHA")
	}
	command := exec.CommandContext(ctx, "git", "-C", workingDir, "rev-parse", "--show-toplevel")
	bytes, err := command.Output()
	if err != nil {
		return nil, errors.New("trusted config requires a Git checkout")
	}
	root := strings.TrimSpace(string(bytes))
	physicalWorkingDir, err := filepath.EvalSymlinks(workingDir)
	if err != nil {
		return nil, err
	}
	within, err := filepath.Rel(root, physicalWorkingDir)
	if err != nil || !inside(root, physicalWorkingDir) {
		return nil, errors.New("trusted working directory is outside checkout")
	}
	lexicalRoot := workingDir
	if within != "." {
		for range strings.Split(within, string(filepath.Separator)) {
			lexicalRoot = filepath.Dir(lexicalRoot)
		}
	}
	local := p
	if inside(lexicalRoot, p) {
		relative, _ := filepath.Rel(lexicalRoot, p)
		local = filepath.Join(root, relative)
	} else {
		resolved, e := filepath.EvalSymlinks(p)
		if e != nil {
			return nil, e
		}
		if !inside(root, resolved) {
			return os.ReadFile(p)
		}
		local = resolved
	}
	if err := r.ensureTrustedCommit(ctx, root, ref); err != nil {
		return nil, err
	}
	relative, err := filepath.Rel(root, local)
	if err != nil {
		return nil, err
	}
	relative = filepath.ToSlash(relative)
	// ls-tree identifies the mode; git show alone would read a symlink's target
	// text as if it were a deployment config.
	command = exec.CommandContext(ctx, "git", "-C", root, "ls-tree", "-z", ref, "--", relative)
	bytes, err = command.Output()
	if err != nil {
		return nil, errors.New("cannot inspect trusted config commit")
	}
	if len(bytes) == 0 {
		return nil, fmt.Errorf("config %s is absent at trusted base: %w", relative, os.ErrNotExist)
	}
	parts := strings.SplitN(strings.TrimSuffix(string(bytes), "\x00"), "\t", 2)
	if len(parts) != 2 || parts[1] != relative {
		return nil, errors.New("trusted config is not an exact tracked path")
	}
	fields := strings.Fields(parts[0])
	if len(fields) != 3 || fields[1] != "blob" || (fields[0] != "100644" && fields[0] != "100755") {
		return nil, errors.New("trusted config must be a regular tracked base file")
	}
	command = exec.CommandContext(ctx, "git", "-C", root, "show", ref+":"+relative)
	bytes, err = command.Output()
	if err != nil {
		return nil, errors.New("cannot read trusted base config")
	}
	return bytes, nil
}

func (r Resolver) ensureTrustedCommit(ctx context.Context, root, ref string) error {
	if exec.CommandContext(ctx, "git", "-C", root, "cat-file", "-e", ref+"^{commit}").Run() == nil {
		return nil
	}
	remoteBytes, err := exec.CommandContext(ctx, "git", "-C", root, "config", "--get", "remote.origin.url").Output()
	if err != nil {
		return errors.New("trusted base commit is unavailable; checkout base history or configure origin")
	}
	remote := strings.TrimSpace(string(remoteBytes))
	header, _ := exec.CommandContext(ctx, "git", "-C", root, "config", "--get-urlmatch", "http.extraheader", remote).Output()
	// Private-config tokens must never authenticate checkout fetches. The Action
	// passes its workflow token through FETCH_TOKEN; local downloads use only the
	// dedicated download token when a fetch credential is needed.
	env := []string{}
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "GITHUB_TOKEN=") && !strings.HasPrefix(entry, "GH_TOKEN=") && !strings.HasPrefix(entry, "ARTIFACT_PAGES_FETCH_TOKEN=") {
			env = append(env, entry)
		}
	}
	token := r.getenv("ARTIFACT_PAGES_FETCH_TOKEN")
	if token == "" {
		token = r.getenv("ARTIFACT_PAGES_DOWNLOAD_TOKEN")
	}
	env = append(env, "ARTIFACT_PAGES_FETCH_TOKEN="+token)
	env, _ = gitdepth.AuthEnv(env, remote, strings.TrimSpace(string(header)) != "")
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	command := exec.CommandContext(ctx, "git", "-C", root, "-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", ref)
	command.Env = env
	if command.Run() != nil {
		return errors.New("trusted base commit fetch failed; checkout base history or make origin readable with the workflow token")
	}
	if exec.CommandContext(ctx, "git", "-C", root, "cat-file", "-e", ref+"^{commit}").Run() != nil {
		return errors.New("trusted base commit remains unavailable")
	}
	return nil
}
