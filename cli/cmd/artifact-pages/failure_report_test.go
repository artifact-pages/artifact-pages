package main

import (
	"bytes"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

func TestCommandFailureReport(t *testing.T) {
	for _, test := range []struct {
		name   string
		args   []string
		err    error
		want   []string
		absent []string
	}{
		{
			name:   "unregistered dry run",
			args:   []string{"site", "publish", "--site", "ja", "--dry-run"},
			err:    &commandError{exitCode: 1, target: &deploymentTarget{Provider: "local"}, err: &publisher.SiteNotRegisteredError{Site: "ja", RegisteredSites: []string{"guide"}}},
			want:   []string{"site publish ja  DRY RUN FAILED", "Target    local", `site "ja" is not registered`, "Registered sites: guide", "Check --site"},
			absent: []string{"PUBLISHED", "Synced", "Some writes", "No writes"},
		},
		{
			name: "invalid input",
			args: []string{"site", "publish"},
			err:  withExitCode(errors.New("--site is required"), 2),
			want: []string{"site publish  FAILED", "--site is required", "Use --help"},
		},
		{
			name:   "partial failure",
			args:   []string{"site", "publish", "--site=sre", "--dry-run=false"},
			err:    &commandError{err: errors.New("permission denied"), exitCode: 1, result: &publisher.Result{Changes: []publisher.Change{{Action: "create", Path: "_artifacts/sre/a.html"}}}},
			want:   []string{"site publish sre  FAILED", "permission denied", "Some writes may have completed"},
			absent: []string{"DRY RUN", "PUBLISHED", "Synced"},
		},
		{
			name:   "transport failure before result",
			args:   []string{"site", "publish", "--site=sre"},
			err:    errors.New("connection refused\n\x1b[31m"),
			want:   []string{"connection refused", "Resolve the error and retry"},
			absent: []string{"\x1b", "Some writes", "No writes"},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var output bytes.Buffer
			writeCommandFailure(&output, test.args, test.err, false)
			for _, value := range test.want {
				if !strings.Contains(output.String(), value) {
					t.Errorf("missing %q in %s", value, output.String())
				}
			}
			for _, value := range test.absent {
				if strings.Contains(output.String(), value) {
					t.Errorf("unexpected %q in %s", value, output.String())
				}
			}
		})
	}
}

func TestFailureRegisteredSitesBounded(t *testing.T) {
	ids := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		ids = append(ids, fmt.Sprintf("site-%02d", i))
	}
	var output bytes.Buffer
	writeCommandFailure(&output, []string{"site", "publish", "--site=missing"}, &publisher.SiteNotRegisteredError{Site: "missing", RegisteredSites: ids}, true)
	if !strings.Contains(output.String(), "8 more") || strings.Contains(output.String(), "site-19") || !strings.Contains(output.String(), "\x1b[38;2;205;170;166mFAILED") {
		t.Fatalf("unexpected report: %q", output.String())
	}
}
