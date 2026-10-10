// Package bootstrap resolves the stable CLI pin before strict command parsing.
package bootstrap

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/config"
)

const (
	VersionEnv       = "ARTIFACT_PAGES_CLI_VERSION"
	ResolvedEnv      = "ARTIFACT_PAGES_CLI_RESOLVED"
	RangeEnv         = "ARTIFACT_PAGES_CLI_RANGE"
	MetadataEnv      = "ARTIFACT_PAGES_CLI_METADATA"
	SkipEnv          = "ARTIFACT_PAGES_CLI_SKIP_RESOLUTION"
	configVersionEnv = "ARTIFACT_PAGES_CLI_CONFIG_VERSION"
)

type Metadata struct {
	SchemaVersion     int    `json:"schemaVersion"`
	CLIVersion        string `json:"cliVersion"`
	ConfigVersion     string `json:"configVersion"`
	Override          bool   `json:"override"`
	OverrideRequested string `json:"overrideRequested"`
	OverrideSource    string `json:"overrideSource"`
	Resolved          bool   `json:"resolved"`
}

type Error struct {
	Err  error
	Code int
}

func (e *Error) Error() string { return e.Err.Error() }
func (e *Error) Unwrap() error { return e.Err }

// Runner dependencies are replaceable only in Go tests; release sources are
// fixed by Installer, never by configuration or runtime environment variables.
type Runner struct {
	Version string
	Getenv  func(string) string
	Resolve func(context.Context, []string) (string, error)
	Install func(context.Context, string) (string, error)
	Execute func(context.Context, string, []string, []string, io.Reader, io.Writer, io.Writer) error
	Environ func() []string
	Stdin   io.Reader
}

func stripOverride(args []string) ([]string, string, bool, error) {
	out := []string{}
	value := ""
	found := false
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			out = append(out, args[i:]...)
			break
		}
		if arg == "--cli-version" || strings.HasPrefix(arg, "--cli-version=") {
			found = true
			if arg == "--cli-version" {
				i++
				if i >= len(args) {
					return nil, "", false, errors.New("--cli-version requires exact MAJOR.MINOR.PATCH")
				}
				value = args[i]
			} else {
				value = strings.TrimPrefix(arg, "--cli-version=")
			}
		} else {
			out = append(out, arg)
		}
	}
	if found && !config.ExactVersion(value) {
		return nil, "", false, errors.New("--cli-version must be exact MAJOR.MINOR.PATCH")
	}
	return out, value, found, nil
}

func deployment(args []string) bool {
	if len(args) < 2 {
		return false
	}
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			return false
		}
	}
	switch args[0] {
	case "app", "site", "registry", "preview", "lock":
		return true
	case "config":
		return args[1] == "check"
	}
	return false
}

func locators(args []string) ([]string, error) {
	out := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			break
		}
		if args[i] == "--config" || args[i] == "-config" {
			i++
			if i == len(args) {
				return nil, errors.New("--config requires a locator")
			}
			out = append(out, args[i])
		} else if strings.HasPrefix(args[i], "--config=") {
			out = append(out, strings.TrimPrefix(args[i], "--config="))
		} else if strings.HasPrefix(args[i], "-config=") {
			out = append(out, strings.TrimPrefix(args[i], "-config="))
		}
	}
	return out, nil
}

// Run returns cleaned arguments and whether a child command already ran. It
// preserves original arguments for re-exec so the override remains observable.
func (r Runner) Run(ctx context.Context, args []string, stdout, stderr io.Writer) (clean []string, executed bool, err error) {
	if r.Getenv == nil {
		r.Getenv = os.Getenv
	}
	if r.Environ == nil {
		r.Environ = os.Environ
	}
	if r.Stdin == nil {
		r.Stdin = os.Stdin
	}
	if r.Resolve == nil {
		r.Resolve = (config.Resolver{}).ResolveCLIVersion
	}
	if r.Install == nil {
		r.Install = (Installer{Getenv: r.Getenv}).Install
	}
	if r.Execute == nil {
		r.Execute = execute
	}
	clean, flagVersion, flagSet, err := stripOverride(args)
	if err != nil {
		return clean, false, &Error{err, 2}
	}
	if isRegistrySetup(clean) {
		if hasRegistrySetupHelp(clean) {
			return clean, false, nil
		}
		if flagSet || r.Getenv(VersionEnv) != "" {
			return clean, false, &Error{errors.New("registry setup always uses the running CLI; remove --cli-version and ARTIFACT_PAGES_CLI_VERSION"), 2}
		}
		// Setup consumes only explicit local files and embedded Action pins. Do
		// not resolve a config pin, contact GitHub, download a CLI, or write
		// bootstrap metadata for this command.
		return clean, false, nil
	}
	override := r.Getenv(VersionEnv)
	source := ""
	if override != "" {
		source = "environment"
	}
	if flagSet {
		override = flagVersion
		source = "flag"
	}
	metadata := Metadata{SchemaVersion: 1, CLIVersion: r.Version, ConfigVersion: r.Getenv(configVersionEnv), OverrideRequested: override, OverrideSource: source}
	writeMetadata := func() error {
		p := r.Getenv(MetadataEnv)
		if p == "" {
			return nil
		}
		bytes, e := json.Marshal(metadata)
		if e != nil {
			return e
		}
		// The wrapper owns this exact temporary filename.
		if info, e := os.Lstat(p); e == nil && !info.Mode().IsRegular() {
			return errors.New("CLI metadata path must be a regular file")
		} else if e != nil && !errors.Is(e, os.ErrNotExist) {
			return e
		}
		f, e := os.OpenFile(p, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
		if e != nil {
			return e
		}
		_, e = f.Write(append(bytes, '\n'))
		ce := f.Close()
		if e != nil {
			return e
		}
		return ce
	}
	if err = writeMetadata(); err != nil {
		return clean, false, &Error{fmt.Errorf("write CLI resolution metadata: %w", err), 1}
	}
	if override != "" && !config.ExactVersion(override) {
		return clean, false, &Error{errors.New("ARTIFACT_PAGES_CLI_VERSION must be exact MAJOR.MINOR.PATCH"), 2}
	}
	if resolved := r.Getenv(ResolvedEnv); resolved != "" {
		if resolved != r.Version {
			return clean, false, &Error{fmt.Errorf("CLI resolution loop guard expected %s, running %s", resolved, r.Version), 2}
		}
		if err = CheckRange(r.Version, r.Getenv(RangeEnv)); err != nil {
			return clean, false, &Error{err, 2}
		}
		metadata.Override = source != "" && override == r.Version
		metadata.Resolved = true
		err = writeMetadata()
		return clean, false, err
	}
	if r.Getenv(SkipEnv) == "1" {
		metadata.Resolved = true
		err = writeMetadata()
		return clean, false, err
	}
	if !deployment(clean) && source == "" {
		metadata.Resolved = true
		err = writeMetadata()
		return clean, false, err
	}
	pin := ""
	if deployment(clean) {
		var ls []string
		ls, err = locators(clean)
		if err == nil {
			pin, err = r.Resolve(ctx, ls)
		}
		if err != nil {
			return clean, false, &Error{err, 2}
		}
	}
	metadata.ConfigVersion = pin
	target := pin
	if override != "" {
		target = override
	}
	if target == "" {
		target = r.Version
	}
	if err = writeMetadata(); err != nil {
		return clean, false, &Error{err, 1}
	}
	if err = CheckRange(target, r.Getenv(RangeEnv)); err != nil {
		return clean, false, &Error{err, 2}
	}
	if target == r.Version {
		metadata.Override = source != ""
		metadata.Resolved = true
		err = writeMetadata()
		return clean, false, err
	}
	binary, err := r.Install(ctx, target)
	if err != nil {
		return clean, false, &Error{err, 1}
	}
	env := withEnv(r.Environ(), ResolvedEnv, target)
	env = withEnv(env, configVersionEnv, pin)
	err = r.Execute(ctx, binary, args, env, r.Stdin, stdout, stderr)
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return clean, true, &Error{err, exit.ExitCode()}
		}
		return clean, false, &Error{err, 1}
	}
	return clean, true, nil
}

func isRegistrySetup(args []string) bool {
	return len(args) >= 2 && args[0] == "registry" && args[1] == "setup"
}

func hasRegistrySetupHelp(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" {
			return true
		}
	}
	return false
}

func withEnv(env []string, key, value string) []string {
	out := make([]string, 0, len(env)+1)
	for _, e := range env {
		if !strings.HasPrefix(e, key+"=") {
			out = append(out, e)
		}
	}
	return append(out, key+"="+value)
}
func execute(ctx context.Context, p string, args, env []string, in io.Reader, out, errOut io.Writer) error {
	c := exec.CommandContext(ctx, p, args...)
	c.Env = env
	c.Stdin = in
	c.Stdout = out
	c.Stderr = errOut
	return c.Run()
}

func compare(a, b string) int {
	aa := strings.Split(a, ".")
	bb := strings.Split(b, ".")
	for i := 0; i < 3; i++ {
		if len(aa[i]) < len(bb[i]) {
			return -1
		}
		if len(aa[i]) > len(bb[i]) {
			return 1
		}
		if aa[i] < bb[i] {
			return -1
		}
		if aa[i] > bb[i] {
			return 1
		}
	}
	return 0
}

// CheckRange supports the Action contract's whitespace-separated comparators.
// Invalid/unsupported ranges fail closed; versions are never coerced.
func CheckRange(version, rangeText string) error {
	if rangeText == "" {
		return nil
	}
	fail := func() error { return fmt.Errorf("CLI %s is outside Action cliRange %q", version, rangeText) }
	if !config.ExactVersion(version) {
		return fail()
	}
	bounds := strings.Fields(rangeText)
	if len(bounds) == 0 {
		return fail()
	}
	for _, bound := range bounds {
		op := ""
		for _, candidate := range []string{">=", "<=", ">", "<", "="} {
			if strings.HasPrefix(bound, candidate) {
				op = candidate
				break
			}
		}
		value := strings.TrimPrefix(bound, op)
		if op == "" || !config.ExactVersion(value) {
			return fmt.Errorf("unsupported Action cliRange %q", rangeText)
		}
		c := compare(version, value)
		if (op == ">=" && c < 0) || (op == "<=" && c > 0) || (op == ">" && c <= 0) || (op == "<" && c >= 0) || (op == "=" && c != 0) {
			return fail()
		}
	}
	return nil
}

func cacheBase(getenv func(string) string) (string, error) {
	if root := getenv("RUNNER_TOOL_CACHE"); root != "" {
		return filepath.Join(root, "artifact-pages"), nil
	}
	root, err := os.UserCacheDir()
	return filepath.Join(root, "artifact-pages", "cli"), err
}
