package main

import (
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"unicode"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

// Keep terminal output bounded; the JSON result always retains the complete list.
const publishReportPathLimit = 12

func terminalColor(writer io.Writer) bool {
	if _, disabled := os.LookupEnv("NO_COLOR"); disabled {
		return false
	}
	if term := os.Getenv("TERM"); term == "" || term == "dumb" {
		return false
	}
	file, ok := writer.(*os.File)
	if !ok || (file != os.Stdout && file != os.Stderr) {
		return false
	}
	info, err := file.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

// Paths and labels may originate in Git. Never let them inject terminal controls.
func reportText(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return '\uFFFD'
		}
		return r
	}, value)
}

func reportTone(value, kind string, color bool) string {
	if !color {
		return value
	}
	// Low-chroma semantic colors, matching the approved CLI concept palette.
	rgb := map[string]string{
		"dry": "176;190;200", "create": "173;191;175",
		"update": "197;185;159", "remove": "205;170;166",
	}[kind]
	if rgb == "" {
		return value
	}
	return "\x1b[38;2;" + rgb + "m" + value + "\x1b[0m"
}

func writeSiteSyncReport(writer io.Writer, result publisher.Result, resolved deploymentconfig.ResolvedConfig, dryRun, color bool) {
	status, tone := "SYNCED", "create"
	if dryRun {
		status, tone = "DRY RUN", "dry"
	} else if result.Outcome == "no-op" {
		status = "UP TO DATE"
	}
	fmt.Fprintf(writer, "site sync %s  %s\n\n", reportText(result.Site), reportTone(status, tone, color))
	target := formatDeploymentTarget(resolved.Config)
	if resolved.Config.Provider == "local" && resolved.Config.Local != nil {
		target = "local · " + resolved.Config.Local.Root
	}
	fmt.Fprintf(writer, "  Target    %s\n", reportText(target))
	if resolved.CommitSHA != "" {
		fmt.Fprintf(writer, "  Config    %s\n", reportText(resolved.CommitSHA))
	}
	fmt.Fprintln(writer)
	for i, action := range []string{"create", "update", "remove"} {
		if i == 0 {
			fmt.Fprint(writer, "  ")
		} else {
			fmt.Fprint(writer, "   ")
		}
		count := changeCount(result.Changes, action)
		marker := map[string]string{"create": "+", "update": "~", "remove": "-"}[action]
		if count > 0 {
			marker = reportTone(marker, action, color)
		}
		fmt.Fprintf(writer, "%s %d %s", marker, count, action)
	}
	fmt.Fprintln(writer)
	changes := append([]publisher.Change(nil), result.Changes...)
	sort.Slice(changes, func(i, j int) bool {
		if changes[i].Path == changes[j].Path {
			return changes[i].Action < changes[j].Action
		}
		return changes[i].Path < changes[j].Path
	})
	for _, group := range []struct{ label, prefix string }{
		{"Artifacts", "_artifacts/" + result.Site + "/"},
		{"Indexes", "_indexes/" + result.Site + "/"},
		{"Other objects", ""},
	} {
		var entries []publisher.Change
		for _, change := range changes {
			matches := strings.HasPrefix(change.Path, group.prefix)
			if group.prefix == "" {
				matches = !strings.HasPrefix(change.Path, "_artifacts/"+result.Site+"/") && !strings.HasPrefix(change.Path, "_indexes/"+result.Site+"/")
			}
			if matches {
				entries = append(entries, change)
			}
		}
		if len(entries) == 0 {
			continue
		}
		fmt.Fprintf(writer, "\n  %s", group.label)
		if group.prefix != "" {
			fmt.Fprintf(writer, " · %s", reportText(group.prefix))
		}
		fmt.Fprintln(writer)
		for i, change := range entries {
			if i == publishReportPathLimit {
				fmt.Fprintf(writer, "    … %d more; use --format json for all paths.\n", len(entries)-i)
				break
			}
			marker := map[string]string{"create": "+", "update": "~", "remove": "-"}[change.Action]
			fmt.Fprintf(writer, "  %s %-6s  %s\n", reportTone(marker, change.Action, color), reportText(change.Action), reportText(strings.TrimPrefix(change.Path, group.prefix)))
		}
	}
	pruned, retained := previewChangeCount(result.PreviewChanges, "remove"), previewChangeCount(result.PreviewChanges, "keep")
	if pruned+retained > 0 {
		verb := "pruned"
		if dryRun {
			verb = "to prune"
		}
		fmt.Fprintf(writer, "\n  Preview catalog: %d stale references %s · %d groups retained.\n", pruned, verb, retained)
	}
	if len(result.InvalidationPaths) > 0 {
		verb := "requested"
		if dryRun {
			verb = "planned"
		}
		fmt.Fprintf(writer, "\n  Cache revalidation: %d paths %s.\n", len(result.InvalidationPaths), verb)
		if result.InvalidationID != "" {
			fmt.Fprintf(writer, "  Request   %s\n", reportText(result.InvalidationID))
		}
	}
	fmt.Fprintln(writer)
	switch {
	case dryRun:
		fmt.Fprintln(writer, "  Dry run complete. No writes.")
	case result.Outcome == "no-op":
		fmt.Fprintln(writer, "  Everything is up to date.")
	default:
		fmt.Fprintf(writer, "  Synced %d files · removed %d stale files.\n", result.FilesPublished, result.FilesRemoved)
	}
}
