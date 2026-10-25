// Command migrate-preview-cache is a one-time helper that rewrites only the
// Cache-Control metadata of one site's preview objects written by older CLIs.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/artifact-pages/artifact-pages/cli/internal/config"
	"github.com/artifact-pages/artifact-pages/cli/internal/deploymentbackend"
	"github.com/artifact-pages/artifact-pages/cli/internal/publisher"
)

func main() {
	os.Exit(run(context.Background(), os.Args[1:], os.Stdout, os.Stderr))
}

func writeUsage(w io.Writer) {
	fmt.Fprintln(w, "migrate-preview-cache: one-time migration helper (not a product command)")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Usage:")
	fmt.Fprintln(w, "  go run ./cli/tools/migrate-preview-cache --config PATH --site ID [--apply] [--format text|json]")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Rewrites only Cache-Control on the preview catalog, revision manifests and owned files of")
	fmt.Fprintln(w, "ONE site when they still carry the legacy values written by older CLIs. Objects are found")
	fmt.Fprintln(w, "only through the catalog ownership ledger and manifests; orphans and other sites are never touched.")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Flags:")
	fmt.Fprintln(w, "  --config PATH   local deployment config file (required)")
	fmt.Fprintln(w, "  --site ID       site whose previews are migrated (required)")
	fmt.Fprintln(w, "  --apply         write changes; the default is a dry run that reads and validates only")
	fmt.Fprintln(w, "  --format FMT    text (default) or json")
	fmt.Fprintln(w, "")
	fmt.Fprintln(w, "Applying takes the site lock. Rewriting metadata changes Last-Modified and may extend")
	fmt.Fprintln(w, "lifecycle retention of the rewritten objects once.")
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("migrate-preview-cache", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "")
	site := flags.String("site", "", "")
	apply := flags.Bool("apply", false, "")
	format := flags.String("format", "text", "")
	help := flags.Bool("help", false, "")
	flags.BoolVar(help, "h", false, "")
	if err := flags.Parse(args); err != nil {
		fmt.Fprintf(stderr, "migrate-preview-cache: %v\n\n", err)
		writeUsage(stderr)
		return 2
	}
	if *help {
		writeUsage(stdout)
		return 0
	}
	usageError := func(message string) int {
		fmt.Fprintf(stderr, "migrate-preview-cache: %s\n\n", message)
		writeUsage(stderr)
		return 2
	}
	if flags.NArg() > 0 {
		return usageError(fmt.Sprintf("unexpected argument %q", flags.Arg(0)))
	}
	if *configPath == "" {
		return usageError("--config is required")
	}
	if *site == "" {
		return usageError("--site is required")
	}
	if *format != "text" && *format != "json" {
		return usageError(fmt.Sprintf("--format must be text or json, got %q", *format))
	}
	contents, err := os.ReadFile(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "migrate-preview-cache: read config: %v\n", err)
		return 2
	}
	cfg, err := config.Parse(contents)
	if err != nil {
		fmt.Fprintf(stderr, "migrate-preview-cache: parse config: %v\n", err)
		return 2
	}
	backend, err := deploymentbackend.New(ctx, cfg, false)
	if err != nil {
		fmt.Fprintf(stderr, "migrate-preview-cache: %v\n", err)
		return 1
	}
	conditional, ok := backend.(publisher.ConditionalObjectBackend)
	if !ok {
		fmt.Fprintf(stderr, "migrate-preview-cache: provider %q does not support origin reads and conditional writes\n", cfg.Provider)
		return 2
	}
	result, err := publisher.MigratePreviewCacheMetadata(ctx, conditional, publisher.PreviewCacheMigrationOptions{SiteID: *site, Apply: *apply})
	if err != nil {
		fmt.Fprintf(stderr, "migrate-preview-cache: %v\n", err)
		return 1
	}
	if *format == "json" {
		encoder := json.NewEncoder(stdout)
		encoder.SetIndent("", "  ")
		if err := encoder.Encode(result); err != nil {
			fmt.Fprintf(stderr, "migrate-preview-cache: %v\n", err)
			return 1
		}
		return 0
	}
	for _, object := range result.Objects {
		if object.Action == "update" || object.Action == "expired" {
			fmt.Fprintf(stdout, "%s %s\n", object.Action, object.Key)
		}
	}
	fmt.Fprintf(stdout, "site %s: %s (updated %d, current %d, expired revisions %d)\n",
		result.Site, result.Outcome, result.Updated, result.Current, result.ExpiredRevisions)
	return 0
}
