package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(k string) string { return values[k] }
}
func TestOverridePrecedenceRangeAndReexec(t *testing.T) {
	for _, tc := range []struct {
		name                           string
		args                           []string
		environment, pin, want, source string
	}{
		{"config", nil, "", "0.1.2", "0.1.2", ""},
		{"environment", nil, "0.1.3", "0.1.2", "0.1.3", "environment"},
		{"flag", []string{"--cli-version", "0.1.4"}, "0.1.3", "0.1.2", "0.1.4", "flag"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			metadata := filepath.Join(t.TempDir(), "resolution.json")
			values := map[string]string{VersionEnv: tc.environment, RangeEnv: ">=0.1.0 <0.2.0", MetadataEnv: metadata}
			args := append([]string{"registry", "sync", "--config", "one", "--config=two", "--format", "json"}, tc.args...)
			installed := ""
			executed := false
			var out, stderr bytes.Buffer
			r := Runner{Version: "0.1.0", Getenv: env(values), Environ: func() []string { return []string{"KEEP=value", ResolvedEnv + "=old"} }, Stdin: strings.NewReader("input"),
				Resolve: func(_ context.Context, locators []string) (string, error) {
					if !reflect.DeepEqual(locators, []string{"one", "two"}) {
						t.Fatal(locators)
					}
					return tc.pin, nil
				},
				Install: func(_ context.Context, v string) (string, error) { installed = v; return "/verified", nil },
				Execute: func(_ context.Context, p string, gotArgs, gotEnv []string, in io.Reader, stdout, errOut io.Writer) error {
					executed = true
					if p != "/verified" || !reflect.DeepEqual(args, gotArgs) || !strings.Contains(strings.Join(gotEnv, "\n"), ResolvedEnv+"="+tc.want) {
						t.Fatalf("%s %v %v", p, gotArgs, gotEnv)
					}
					b, _ := io.ReadAll(in)
					if string(b) != "input" {
						t.Fatal(string(b))
					}
					io.WriteString(stdout, "child-json\n")
					io.WriteString(errOut, "child-stderr\n")
					return nil
				},
			}
			clean, done, err := r.Run(t.Context(), args, &out, &stderr)
			if err != nil || !done || !executed || installed != tc.want || len(clean) != 7 || out.String() != "child-json\n" || stderr.String() != "child-stderr\n" {
				t.Fatalf("%v %v %s %v %s", err, done, installed, clean, out.String())
			}
			var m Metadata
			b, _ := os.ReadFile(metadata)
			json.Unmarshal(b, &m)
			requested := tc.want
			if tc.source == "" {
				requested = ""
			}
			if m.CLIVersion != "0.1.0" || m.ConfigVersion != tc.pin || m.OverrideSource != tc.source || m.OverrideRequested != requested || m.Override || m.Resolved {
				t.Fatalf("%+v", m)
			}
		})
	}
}
func TestRangeFailsBeforeDownload(t *testing.T) {
	for _, v := range []string{"0.0.9", "0.2.0", "1.0.0", "0.1.0-rc.1"} {
		r := Runner{Version: "0.1.0", Getenv: env(map[string]string{VersionEnv: v, RangeEnv: ">=0.1.0 <0.2.0"}), Resolve: func(context.Context, []string) (string, error) { return "0.1.0", nil }, Install: func(context.Context, string) (string, error) {
			t.Fatal("download before range validation")
			return "", nil
		}}
		_, _, err := r.Run(t.Context(), []string{"app", "deploy"}, io.Discard, io.Discard)
		var e *Error
		if !errors.As(err, &e) || e.Code != 2 {
			t.Fatal(err)
		}
	}
	for _, rangeText := range []string{"latest", "^0.1.0", ">=0.1.0 || <0.2.0", " "} {
		if CheckRange("0.1.0", rangeText) == nil {
			t.Fatal(rangeText)
		}
	}
	if err := CheckRange("0.1.9", ">=0.1.0 <0.2.0"); err != nil {
		t.Fatal(err)
	}
}
func TestLoopGuardAndSourceTestSkip(t *testing.T) {
	r := Runner{Version: "0.1.0", Resolve: func(context.Context, []string) (string, error) {
		t.Fatal("loop/source path resolved config")
		return "", nil
	}, Install: func(context.Context, string) (string, error) {
		t.Fatal("loop/source path installed binary")
		return "", nil
	}}
	r.Getenv = env(map[string]string{ResolvedEnv: "0.1.1"})
	_, _, err := r.Run(t.Context(), []string{"site", "sync"}, io.Discard, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "loop guard") {
		t.Fatal(err)
	}
	r.Getenv = env(map[string]string{ResolvedEnv: "0.1.0"})
	_, done, err := r.Run(t.Context(), []string{"site", "sync"}, io.Discard, io.Discard)
	if err != nil || done {
		t.Fatal(err)
	}
	r.Getenv = env(map[string]string{SkipEnv: "1", VersionEnv: "0.1.5"})
	_, done, err = r.Run(t.Context(), []string{"site", "sync"}, io.Discard, io.Discard)
	if err != nil || done {
		t.Fatal(err)
	}
	// A raw TEST_CLI variable alone never bypasses a published bootstrap.
	r.Getenv = env(map[string]string{"ARTIFACT_PAGES_TEST_CLI": "/tmp/test"})
	r.Resolve = func(context.Context, []string) (string, error) { return "", errors.New("still resolved") }
	_, _, err = r.Run(t.Context(), []string{"site", "sync"}, io.Discard, io.Discard)
	if err == nil || err.Error() != "still resolved" {
		t.Fatal(err)
	}
}
func TestNonDeploymentDoesNotRequireConfig(t *testing.T) {
	r := Runner{Version: "0.1.0", Getenv: env(nil), Resolve: func(context.Context, []string) (string, error) { t.Fatal("resolved nondeployment"); return "", nil }}
	for _, args := range [][]string{{"version"}, {"compatibility", "--format", "json"}, {"site", "sync", "--help"}, {"config", "set-default", "example"}, {"index", "build"}} {
		_, done, err := r.Run(t.Context(), args, io.Discard, io.Discard)
		if err != nil || done {
			t.Fatalf("%v %v", args, err)
		}
	}
}
func TestRealChildPreservesExitAndStreams(t *testing.T) {
	if os.PathSeparator != '/' {
		t.Skip("Unix released platform")
	}
	p := filepath.Join(t.TempDir(), "target")
	os.WriteFile(p, []byte("#!/bin/sh\nread line\nprintf '%s|%s|%s' \"$line\" \"$2\" \"$ARTIFACT_PAGES_CLI_RESOLVED\"\nprintf child-error >&2\nexit 7\n"), 0700)
	r := Runner{Version: "0.1.0", Getenv: env(map[string]string{VersionEnv: "0.1.1"}), Install: func(context.Context, string) (string, error) { return p, nil }, Environ: func() []string { return []string{} }, Stdin: strings.NewReader("stdin-value\n")}
	var stdout, stderr bytes.Buffer
	_, done, err := r.Run(t.Context(), []string{"version", "--format=json"}, &stdout, &stderr)
	var e *Error
	if !done || !errors.As(err, &e) || e.Code != 7 || stdout.String() != "stdin-value|--format=json|0.1.1" || stderr.String() != "child-error" {
		t.Fatalf("%v %v %q %q", done, err, stdout.String(), stderr.String())
	}
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatal("exit wrapper lost cause")
	}
}

func TestOverrideRequestIsNotAppliedWhenSkippedOrDownloadFails(t *testing.T) {
	for _, tc := range []struct {
		name         string
		skip         bool
		wantResolved bool
	}{
		{"source test skip", true, true}, {"download failure", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			metadataPath := filepath.Join(t.TempDir(), "metadata.json")
			values := map[string]string{VersionEnv: "0.1.9", MetadataEnv: metadataPath, RangeEnv: ">=0.1.0 <0.2.0"}
			if tc.skip {
				values[SkipEnv] = "1"
			}
			called := false
			r := Runner{Version: "0.1.0", Getenv: env(values), Resolve: func(context.Context, []string) (string, error) {
				if tc.skip {
					t.Fatal("test skip resolved config")
				}
				return "0.1.1", nil
			}, Install: func(context.Context, string) (string, error) {
				called = true
				return "", errors.New("fixture download unavailable")
			}}
			_, done, err := r.Run(t.Context(), []string{"registry", "sync"}, io.Discard, io.Discard)
			if done || tc.skip && err != nil || !tc.skip && err == nil || called != !tc.skip {
				t.Fatalf("done=%t err=%v installed=%t", done, err, called)
			}
			if !tc.skip {
				var e *Error
				if !errors.As(err, &e) || e.Code != 1 {
					t.Fatalf("download error did not retain exit 1: %v", err)
				}
			}
			var m Metadata
			body, _ := os.ReadFile(metadataPath)
			if e := json.Unmarshal(body, &m); e != nil {
				t.Fatal(e)
			}
			if m.CLIVersion != "0.1.0" || m.Override || m.OverrideRequested != "0.1.9" || m.OverrideSource != "environment" || m.Resolved != tc.wantResolved {
				t.Fatalf("%+v", m)
			}
		})
	}
}

func TestResolvedOverrideIsAppliedOnlyAfterRangeGuard(t *testing.T) {
	for _, rangeText := range []string{">=0.1.0 <0.2.0", ">=0.2.0 <0.3.0"} {
		metadataPath := filepath.Join(t.TempDir(), "metadata.json")
		r := Runner{Version: "0.1.9", Getenv: env(map[string]string{VersionEnv: "0.1.9", ResolvedEnv: "0.1.9", RangeEnv: rangeText, MetadataEnv: metadataPath})}
		_, _, err := r.Run(t.Context(), []string{"registry", "sync"}, io.Discard, io.Discard)
		var m Metadata
		body, _ := os.ReadFile(metadataPath)
		if e := json.Unmarshal(body, &m); e != nil {
			t.Fatal(e)
		}
		allowed := rangeText == ">=0.1.0 <0.2.0"
		if (err == nil) != allowed || m.Override != allowed || m.OverrideRequested != "0.1.9" || m.Resolved != allowed {
			t.Fatalf("range=%s metadata=%+v err=%v", rangeText, m, err)
		}
	}
}
