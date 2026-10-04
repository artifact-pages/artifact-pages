// Package gitdepth lets read-side CLI code work from a shallow Git checkout.
//
// History-dependent features (per-document Git metadata and the preview
// merge-base) call into this package to detect a shallow repository, learn
// which commits are shallow boundaries, and deepen the checkout from its
// origin on demand. Full clones never reach the fetching code.
package gitdepth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

var shaPattern = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)

// DeepenSteps are the cumulative increments applied before falling back to a
// complete unshallow. Each value is passed to `git fetch --deepen`.
var DeepenSteps = []int{8, 32, 128, 512, 2048}

// IsShallow reports whether the repository containing dir is a shallow clone.
func IsShallow(ctx context.Context, dir string) (bool, error) {
	output, err := run(ctx, dir, nil, "rev-parse", "--is-shallow-repository")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(output) == "true", nil
}

// Boundaries returns the commits whose parents were cut off by shallow
// history. Git treats each as a parentless root, so a diff against it lists
// every file in its tree as added.
func Boundaries(ctx context.Context, dir string) (map[string]struct{}, error) {
	pathOutput, err := run(ctx, dir, nil, "rev-parse", "--git-path", "shallow")
	if err != nil {
		return nil, err
	}
	shallowPath := strings.TrimSpace(pathOutput)
	if !strings.HasPrefix(shallowPath, "/") {
		topLevel, topErr := run(ctx, dir, nil, "rev-parse", "--show-toplevel")
		if topErr != nil {
			return nil, topErr
		}
		shallowPath = strings.TrimSpace(topLevel) + "/" + shallowPath
	}
	data, err := os.ReadFile(shallowPath)
	if errors.Is(err, os.ErrNotExist) {
		return map[string]struct{}{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Git shallow file: %w", err)
	}
	boundaries := make(map[string]struct{})
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if shaPattern.MatchString(line) {
			boundaries[line] = struct{}{}
		}
	}
	return boundaries, nil
}

// Deepen fetches `by` more commits of history below the given tips from
// origin. Tips must be full commit SHAs.
func Deepen(ctx context.Context, dir string, by int, tips ...string) error {
	return fetch(ctx, dir, "--deepen="+strconv.Itoa(by), tips)
}

// Unshallow fetches the complete history below the given tips from origin. It
// is a no-op when the repository is already complete.
func Unshallow(ctx context.Context, dir string, tips ...string) error {
	shallow, err := IsShallow(ctx, dir)
	if err != nil || !shallow {
		return err
	}
	return fetch(ctx, dir, "--unshallow", tips)
}

// FetchShallowRef fetches one ref or commit at depth 1 from origin into a
// shallow checkout so that it can be resolved locally. refspec is either a
// full commit SHA or a `+refs/heads/NAME:refs/remotes/origin/NAME` mapping.
func FetchShallowRef(ctx context.Context, dir, refspec string) error {
	if !shaPattern.MatchString(refspec) && !strings.HasPrefix(refspec, "+refs/heads/") {
		return fmt.Errorf("refuse to fetch unsupported refspec %q", refspec)
	}
	return fetch(ctx, dir, "--depth=1", []string{refspec})
}

func fetch(ctx context.Context, dir, depthFlag string, tips []string) error {
	for _, tip := range tips {
		if !shaPattern.MatchString(tip) && !strings.HasPrefix(tip, "+refs/heads/") {
			return fmt.Errorf("refuse to fetch unsupported tip %q", tip)
		}
	}
	remote, _ := run(ctx, dir, nil, "config", "--get", "remote.origin.url")
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return errors.New("checkout has no origin remote to deepen shallow history from")
	}
	existingHeader, _ := run(ctx, dir, nil, "config", "--get-urlmatch", "http.extraheader", remote)
	env, secrets := AuthEnv(os.Environ(), remote, strings.TrimSpace(existingHeader) != "")
	env = append(env, "GIT_TERMINAL_PROMPT=0")
	args := append([]string{"fetch", "--quiet", "--no-tags", "--no-recurse-submodules", depthFlag, "origin"}, tips...)
	output, err := run(ctx, dir, env, args...)
	if err != nil {
		return fmt.Errorf("deepen shallow checkout: git fetch %s failed (%s); %w", depthFlag, redact(output, secrets), errShallowFetch)
	}
	return nil
}

var errShallowFetch = errors.New("check out with full history (actions/checkout fetch-depth: 0) or make origin readable with a GITHUB_TOKEN/GH_TOKEN")

// AuthEnv returns environ extended with a one-shot http.extraheader for the
// fetch subprocess when a GitHub token is available, the remote is an HTTPS
// GitHub host, and the checkout does not already carry its own header. The
// token is never written to Git configuration; it exists only in the child
// environment. The second result lists strings that must be redacted from any
// output.
func AuthEnv(environ []string, remote string, hasExtraHeader bool) ([]string, []string) {
	if hasExtraHeader {
		return append([]string(nil), environ...), nil
	}
	lookup := func(name string) string {
		prefix := name + "="
		for index := len(environ) - 1; index >= 0; index-- {
			if strings.HasPrefix(environ[index], prefix) {
				return environ[index][len(prefix):]
			}
		}
		return ""
	}
	// ARTIFACT_PAGES_FETCH_TOKEN wins: the Actions set it to the workflow token
	// because GITHUB_TOKEN may carry a token scoped to a separate config repository.
	token := strings.TrimSpace(lookup("ARTIFACT_PAGES_FETCH_TOKEN"))
	if token == "" {
		token = strings.TrimSpace(lookup("GITHUB_TOKEN"))
	}
	if token == "" {
		token = strings.TrimSpace(lookup("GH_TOKEN"))
	}
	parsed, err := url.Parse(remote)
	if token == "" || err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" {
		return append([]string(nil), environ...), nil
	}
	allowed := strings.EqualFold(parsed.Hostname(), "github.com")
	if server, serverErr := url.Parse(lookup("GITHUB_SERVER_URL")); serverErr == nil && server.Hostname() != "" &&
		strings.EqualFold(server.Hostname(), parsed.Hostname()) {
		allowed = true
	}
	if !allowed {
		return append([]string(nil), environ...), nil
	}
	encoded := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
	count := 0
	if value, convErr := strconv.Atoi(lookup("GIT_CONFIG_COUNT")); convErr == nil && value > 0 {
		count = value
	}
	filtered := make([]string, 0, len(environ)+3)
	for _, entry := range environ {
		if !strings.HasPrefix(entry, "GIT_CONFIG_COUNT=") {
			filtered = append(filtered, entry)
		}
	}
	filtered = append(filtered,
		"GIT_CONFIG_COUNT="+strconv.Itoa(count+1),
		fmt.Sprintf("GIT_CONFIG_KEY_%d=http.%s://%s/.extraheader", count, parsed.Scheme, parsed.Host),
		fmt.Sprintf("GIT_CONFIG_VALUE_%d=AUTHORIZATION: basic %s", count, encoded),
	)
	return filtered, []string{token, encoded}
}

func redact(text string, secrets []string) string {
	for _, secret := range secrets {
		if secret != "" {
			text = strings.ReplaceAll(text, secret, "***")
		}
	}
	return text
}

// EnsureMergeBase returns the merge-base of two commits. In a shallow checkout
// it deepens history until the result is exact: a merge-base exists and every
// shallow boundary reachable from either tip is an ancestor of (or equal to)
// it, so no more recent common ancestor can be hidden beyond the boundary.
// After DeepenSteps are exhausted it unshallows.
func EnsureMergeBase(ctx context.Context, dir, first, second string) (string, error) {
	shallow, err := IsShallow(ctx, dir)
	if err != nil {
		return "", err
	}
	if !shallow {
		return mergeBase(ctx, dir, first, second)
	}
	for step := 0; ; step++ {
		base, baseErr := mergeBase(ctx, dir, first, second)
		if baseErr == nil {
			exact, exactErr := boundariesBelow(ctx, dir, base, first, second)
			if exactErr != nil {
				return "", exactErr
			}
			if exact {
				return base, nil
			}
		}
		if step > len(DeepenSteps) {
			// Already unshallowed and still not exact.
			if baseErr != nil {
				return "", fmt.Errorf("no merge base exists between %s and %s even with complete history", first, second)
			}
			return base, nil
		}
		if step < len(DeepenSteps) {
			err = Deepen(ctx, dir, DeepenSteps[step], first, second)
		} else {
			err = Unshallow(ctx, dir, first, second)
		}
		if err != nil {
			return "", err
		}
	}
}

func mergeBase(ctx context.Context, dir, first, second string) (string, error) {
	output, err := run(ctx, dir, nil, "merge-base", first, second)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(output), nil
}

func boundariesBelow(ctx context.Context, dir, base, first, second string) (bool, error) {
	boundaries, err := Boundaries(ctx, dir)
	if err != nil {
		return false, err
	}
	for boundary := range boundaries {
		reachable := false
		for _, tip := range []string{first, second} {
			if _, ancestorErr := run(ctx, dir, nil, "merge-base", "--is-ancestor", boundary, tip); ancestorErr == nil {
				reachable = true
				break
			}
		}
		if !reachable {
			continue
		}
		if _, ancestorErr := run(ctx, dir, nil, "merge-base", "--is-ancestor", boundary, base); ancestorErr != nil {
			return false, nil
		}
	}
	return true, nil
}

func run(ctx context.Context, dir string, env []string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = dir
	if env != nil {
		command.Env = env
	}
	var stdout, stderr strings.Builder
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		return strings.TrimSpace(stderr.String()), fmt.Errorf("git %s: %w", args[0], err)
	}
	return stdout.String(), nil
}
