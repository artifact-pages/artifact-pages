package main

import (
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	deploymentconfig "github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

func reportHeader(w io.Writer, operation, outcome string, dry bool) {
	status, tone := strings.ToUpper(strings.ReplaceAll(outcome, "-", " ")), "create"
	if dry {
		status, tone = "DRY RUN", "dry"
	} else if outcome == "no-op" {
		status = "UP TO DATE"
	} else if outcome == "inspected" || outcome == "no-preview" {
		tone = "dry"
	}
	fmt.Fprintf(w, "%s  %s\n\n", reportText(operation), reportTone(status, tone, terminalColor(w)))
}

func reportTarget(w io.Writer, resolved deploymentconfig.ResolvedConfig) {
	target := formatDeploymentTarget(resolved.Config)
	if resolved.Config.Local != nil {
		target = "local · " + resolved.Config.Local.Root
	}
	fmt.Fprintf(w, "  Target    %s\n", reportText(target))
	if resolved.CommitSHA != "" {
		fmt.Fprintf(w, "  Config    %s\n", reportText(resolved.CommitSHA))
	}
}

func actionMarker(action string, color bool) string {
	marker, tone := "·", ""
	switch action {
	case "create", "publish", "add":
		marker, tone = "+", "create"
	case "update", "replace":
		marker, tone = "~", "update"
	case "remove", "delete":
		marker, tone = "-", "remove"
	case "invalidate":
		marker, tone = "↻", "dry"
	}
	return reportTone(marker, tone, color)
}

func reportChanges(w io.Writer, label string, changes []publisher.Change) {
	if len(changes) == 0 {
		return
	}
	ordered := append([]publisher.Change(nil), changes...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Path == ordered[j].Path {
			return ordered[i].Action < ordered[j].Action
		}
		return ordered[i].Path < ordered[j].Path
	})
	fmt.Fprintf(w, "\n  %s · %d\n", label, len(changes))
	for i, change := range ordered {
		if i == publishReportPathLimit {
			fmt.Fprintf(w, "    … %d more; use --format json for all entries.\n", len(ordered)-i)
			break
		}
		fmt.Fprintf(w, "  %s %-10s %s\n", actionMarker(change.Action, terminalColor(w)), reportText(change.Action), reportText(change.Path))
	}
}

func writeDeploymentReport(w io.Writer, result publisher.Result, resolved deploymentconfig.ResolvedConfig, dry bool) {
	operation := result.Operation
	if result.Site != "" {
		operation += " " + result.Site
	}
	if result.Version != "" {
		operation += " " + result.Version
	}
	reportHeader(w, operation, result.Outcome, dry)
	reportTarget(w, resolved)
	if result.Lock != nil {
		lock := result.Lock
		fmt.Fprintf(w, "\n  State     %s\n", reportText(lock.State))
		if lock.ETag != "" {
			fmt.Fprintf(w, "  ETag      %s\n", reportText(lock.ETag))
		}
		if lock.Owner != "" {
			fmt.Fprintf(w, "  Owner     %s\n", reportText(lock.Owner))
		}
		if !lock.AcquiredAt.IsZero() {
			fmt.Fprintf(w, "  Acquired  %s\n", lock.AcquiredAt.Format(time.RFC3339))
		}
		if result.Outcome == "inspected" {
			fmt.Fprintln(w, "\n  Inspection complete. No writes. Recovery is a separate explicit operation.")
		} else {
			fmt.Fprintln(w, "\n  Recovery complete. State and ETag above are from a fresh inspection.")
		}
		return
	}
	counts := map[string]int{}
	for _, change := range result.Changes {
		counts[change.Action]++
	}
	fmt.Fprintf(w, "\n  %s %d create   %s %d update   %s %d remove", countMarker("create", counts, w), counts["create"], countMarker("update", counts, w), counts["update"], countMarker("remove", counts, w), counts["remove"])
	if counts["invalidate"] > 0 {
		fmt.Fprintf(w, "   %s %d invalidate", actionMarker("invalidate", terminalColor(w)), counts["invalidate"])
	}
	fmt.Fprintln(w)
	groups := map[string][]publisher.Change{}
	for _, change := range result.Changes {
		label := "Application files"
		if strings.HasPrefix(result.Operation, "registry ") {
			switch {
			case change.Action == "invalidate":
				label = "Cache revalidation"
			case strings.Contains(change.Path, "#sites/"):
				label = "Site registrations"
			case change.Path == "_indexes/sites.json":
				label = "Registry projection"
			case strings.HasPrefix(change.Path, "/"):
				label = "Site cleanup scopes"
			default:
				label = "Site cleanup"
			}
		}
		groups[label] = append(groups[label], change)
	}
	for _, label := range []string{"Site registrations", "Registry projection", "Site cleanup scopes", "Site cleanup", "Cache revalidation", "Application files"} {
		reportChanges(w, label, groups[label])
	}
	if result.RegistryUpdated != nil {
		verb := "unchanged"
		if *result.RegistryUpdated {
			verb = "updated"
			if dry {
				verb = "will update"
			}
		}
		fmt.Fprintf(w, "\n  Registry projection: %s.\n", verb)
	}
	if result.InvalidationID != "" {
		fmt.Fprintf(w, "\n  Cache revalidation request: %s\n", reportText(result.InvalidationID))
	}
	switch {
	case dry:
		fmt.Fprintln(w, "\n  Dry run complete. No writes.")
	case result.Outcome == "no-op":
		fmt.Fprintln(w, "\n  Everything is up to date.")
	case result.Operation == "app deploy":
		fmt.Fprintf(w, "\n  Deployed %d application files.\n", result.FilesPublished)
	default:
		fmt.Fprintf(w, "\n  Registry reconciliation complete · %d objects removed.\n", result.FilesRemoved)
	}
}

func countMarker(action string, counts map[string]int, w io.Writer) string {
	return actionMarker(action, counts[action] > 0 && terminalColor(w))
}

func writeIndexReport(w io.Writer, site string, result indexer.BuildResult, indexPath, metaPath string) {
	reportHeader(w, "index build "+site, "built", false)
	fmt.Fprintf(w, "  Indexed   %d artifacts\n  Scanned   %d files\n  Elapsed   %s\n", result.ArtifactsIndexed, result.FilesScanned, result.Elapsed.Round(time.Millisecond))
	fmt.Fprintf(w, "\n  Output files\n  %s %s (%d bytes)\n  %s %s (%d bytes)\n", reportTone("✓", "create", terminalColor(w)), reportText(indexPath), result.OutputBytes, reportTone("✓", "create", terminalColor(w)), reportText(metaPath), result.MetadataBytes)
	if len(result.SearchFiles) > 0 {
		fmt.Fprintf(w, "  ✓ Full-text search (%d files, %d bytes)\n", len(result.SearchFiles), result.SearchBytes)
	}
	fmt.Fprintln(w, "\n  Index build complete. No artifacts were copied or published.")
}

func writeConfigReport(w io.Writer, locator, path string) {
	reportHeader(w, "config set-default", "saved", false)
	fmt.Fprintf(w, "  Locator   %s\n  Saved in  %s\n\n  Updated only the user's default locator. No deployment changes.\n", reportText(locator), reportText(path))
}
