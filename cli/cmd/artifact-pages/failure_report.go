package main

import (
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/tasuku43/git-artifact-pages/cli/internal/publisher"
)

func requestedDryRun(args []string) bool {
	dry := false
	for _, arg := range args {
		switch arg {
		case "--dry-run", "--dry-run=true", "--dry-run=1":
			dry = true
		case "--dry-run=false", "--dry-run=0":
			dry = false
		}
	}
	return dry
}

func writeCommandFailure(writer io.Writer, args []string, err error, color bool) {
	operation := failureEnvelopeOperation(args)
	if site := failureSite(args); site != "" {
		operation += " " + site
	}
	status := "FAILED"
	if requestedDryRun(args) {
		status = "DRY RUN FAILED"
	}
	fmt.Fprintf(writer, "%s  %s\n\n", reportText(operation), reportTone(status, "remove", color))
	var commandErr *commandError
	if errors.As(err, &commandErr) {
		if target := commandErr.target; target != nil {
			label := target.Provider
			if target.Bucket != "" {
				label += " · " + target.Bucket
			}
			fmt.Fprintf(writer, "  Target    %s\n", reportText(label))
		}
		if commandErr.configCommitSHA != "" {
			fmt.Fprintf(writer, "  Deployment config commit: %s\n", reportText(commandErr.configCommitSHA))
		}
	}
	fmt.Fprintf(writer, "  %s error: %s\n", reportTone("×", "remove", color), reportText(err.Error()))
	var unregistered *publisher.SiteNotRegisteredError
	if errors.As(err, &unregistered) {
		ids := unregistered.RegisteredSites
		if len(ids) == 0 {
			fmt.Fprintln(writer, "\n  No sites are registered at this target.")
		} else {
			suffix := ""
			if len(ids) > publishReportPathLimit {
				suffix = fmt.Sprintf(" · %d more", len(ids)-publishReportPathLimit)
				ids = ids[:publishReportPathLimit]
			}
			fmt.Fprintf(writer, "\n  Registered sites: %s%s\n", reportText(strings.Join(ids, ", ")), suffix)
		}
		fmt.Fprintln(writer, "  Check --site and the selected config's deployment target.")
		fmt.Fprintln(writer, "  To add a new site, have the registry owner register it before publishing.")
	} else if commandErr != nil && commandErr.exitCode == 2 {
		fmt.Fprintln(writer, "\n  Check the command arguments and config. Use --help for options.")
	} else {
		fmt.Fprintln(writer, "\n  Resolve the error and retry.")
		if !requestedDryRun(args) && commandErr != nil && commandErr.result != nil && len(commandErr.result.Changes) > 0 {
			fmt.Fprintln(writer, "  Some writes may have completed; this report does not confirm a successful publish.")
		}
	}
}
