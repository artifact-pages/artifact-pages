// Command scale-fixtures generates and verifies the committed publisher scale corpus.
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type config struct {
	SchemaVersion int                 `json:"schemaVersion"`
	GeneratedRoot string              `json:"generatedRoot"`
	Profiles      map[string][]string `json:"profiles"`
	Datasets      []dataset           `json:"datasets"`
}

type dataset struct {
	ID              string `json:"id"`
	SourceFiles     int    `json:"sourceFiles"`
	HTMLPages       int    `json:"htmlPages"`
	MarkdownPages   int    `json:"markdownPages"`
	StaticResources int    `json:"staticResources"`
}

var safeSiteID = regexp.MustCompile(`^verify-scale-[1-9][0-9]*$`)

func main() {
	profile := flag.String("profile", "full", "fixture profile: smoke or full")
	configPath := flag.String("config", "scale/config.json", "path to fixture profile configuration")
	check := flag.Bool("check", false, "verify generated files without changing them")
	flag.Parse()
	if flag.NArg() != 0 {
		fatalf("unexpected arguments: %v", flag.Args())
	}

	if err := run(*profile, *configPath, *check); err != nil {
		fatalf("%v", err)
	}
}

func run(profileName, configPath string, check bool) error {
	configBytes, err := os.ReadFile(configPath)
	if err != nil {
		return fmt.Errorf("read config %q: %w", configPath, err)
	}
	var cfg config
	if err := json.Unmarshal(configBytes, &cfg); err != nil {
		return fmt.Errorf("decode config %q: %w", configPath, err)
	}
	if err := validateConfig(cfg); err != nil {
		return err
	}
	selectedIDs, ok := cfg.Profiles[profileName]
	if !ok {
		return fmt.Errorf("unknown profile %q; choose one of: %s", profileName, strings.Join(sortedKeys(cfg.Profiles), ", "))
	}

	configDir, err := filepath.Abs(filepath.Dir(configPath))
	if err != nil {
		return fmt.Errorf("resolve config directory: %w", err)
	}
	generatedRoot := filepath.Join(configDir, filepath.FromSlash(cfg.GeneratedRoot))
	datasetByID := make(map[string]dataset, len(cfg.Datasets))
	for _, item := range cfg.Datasets {
		datasetByID[item.ID] = item
	}

	totalFiles, totalHTML, totalMarkdown, totalResources := 0, 0, 0, 0
	for _, id := range selectedIDs {
		item := datasetByID[id]
		files := generateFiles(item)
		if len(files) != item.SourceFiles {
			return fmt.Errorf("generator produced %d files for %s; config requires %d", len(files), id, item.SourceFiles)
		}
		sourceRoot := filepath.Join(generatedRoot, id, "source")
		if check {
			if err := checkFiles(sourceRoot, files); err != nil {
				return fmt.Errorf("%s: %w", id, err)
			}
		} else if err := writeFiles(sourceRoot, files); err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
		pages := item.HTMLPages + item.MarkdownPages
		totalFiles += item.SourceFiles
		totalHTML += item.HTMLPages
		totalMarkdown += item.MarkdownPages
		totalResources += item.StaticResources
		verb := "generated"
		if check {
			verb = "verified"
		}
		fmt.Printf("%s %s: %d source files (%d pages: %d HTML, %d Markdown; %d static resources)\n",
			verb, id, item.SourceFiles, pages, item.HTMLPages, item.MarkdownPages, item.StaticResources)
	}
	fmt.Printf("profile %s: %d datasets, %d source files (%d HTML pages, %d Markdown pages, %d static resources)\n",
		profileName, len(selectedIDs), totalFiles, totalHTML, totalMarkdown, totalResources)
	return nil
}

func validateConfig(cfg config) error {
	if cfg.SchemaVersion != 1 {
		return fmt.Errorf("config schemaVersion must be 1")
	}
	if cfg.GeneratedRoot == "" || filepath.IsAbs(filepath.FromSlash(cfg.GeneratedRoot)) || filepath.Clean(filepath.FromSlash(cfg.GeneratedRoot)) == ".." || strings.HasPrefix(filepath.Clean(filepath.FromSlash(cfg.GeneratedRoot)), ".."+string(filepath.Separator)) {
		return errors.New("generatedRoot must be a non-empty relative path within the config directory")
	}
	if len(cfg.Profiles) == 0 || len(cfg.Datasets) == 0 {
		return errors.New("config must define profiles and datasets")
	}
	datasetIDs := make(map[string]bool, len(cfg.Datasets))
	for _, item := range cfg.Datasets {
		if !safeSiteID.MatchString(item.ID) {
			return fmt.Errorf("dataset ID %q must be a path-safe verify-scale ID", item.ID)
		}
		if datasetIDs[item.ID] {
			return fmt.Errorf("duplicate dataset ID %q", item.ID)
		}
		datasetIDs[item.ID] = true
		if item.SourceFiles <= 0 || item.HTMLPages <= 0 || item.MarkdownPages <= 0 || item.StaticResources <= 0 {
			return fmt.Errorf("dataset %q must have positive source, HTML, Markdown, and resource counts", item.ID)
		}
		if item.HTMLPages+item.MarkdownPages+item.StaticResources != item.SourceFiles {
			return fmt.Errorf("dataset %q count mismatch: sourceFiles must equal HTML + Markdown + static resources", item.ID)
		}
	}
	for profile, ids := range cfg.Profiles {
		if profile == "" || len(ids) == 0 {
			return errors.New("profile names and profile datasets must be non-empty")
		}
		seen := make(map[string]bool, len(ids))
		for _, id := range ids {
			if !datasetIDs[id] {
				return fmt.Errorf("profile %q refers to unknown dataset %q", profile, id)
			}
			if seen[id] {
				return fmt.Errorf("profile %q includes dataset %q more than once", profile, id)
			}
			seen[id] = true
		}
	}
	return nil
}

func generateFiles(item dataset) map[string][]byte {
	files := make(map[string][]byte, item.SourceFiles)
	for i := 0; i < item.HTMLPages; i++ {
		files[htmlPagePath(i)] = htmlPage(item.ID, i)
	}
	for i := 0; i < item.MarkdownPages; i++ {
		files[markdownPagePath(i)] = markdownPage(item.ID, i)
	}
	for i := 0; i < item.StaticResources; i++ {
		files[resourcePath(i)] = resource(item.ID, i)
	}
	return files
}

func htmlPagePath(i int) string {
	if i == 0 {
		return "pages/café/overview + 100%.html"
	}
	return fmt.Sprintf("pages/chapters/chapter-%03d/page-%05d.html", i/100, i)
}

func markdownPagePath(i int) string {
	if i == 0 {
		return "pages/日本語/notes ?draft#1.md"
	}
	return fmt.Sprintf("pages/notes/volume-%03d/note-%05d.md", i/100, i)
}

var specialResourcePaths = []string{
	"assets/styles/site.css",
	"assets/scripts/runtime.js",
	"assets/data/catalog.json",
	"assets/images/branding #1.svg",
	"assets/downloads/summary ?mode=full+text.txt",
	"assets/locale/日本語/version%25.dat",
}

var resourceExtensions = []string{"css", "js", "json", "svg", "txt", "dat"}

func resourcePath(i int) string {
	if i < len(specialResourcePaths) {
		return specialResourcePaths[i]
	}
	ext := resourceExtensions[i%len(resourceExtensions)]
	return fmt.Sprintf("assets/content/%s/batch-%03d/resource-%05d.%s", extDirectory(ext), i/500, i, ext)
}

func extDirectory(ext string) string {
	if ext == "js" {
		return "scripts"
	}
	if ext == "json" {
		return "data"
	}
	if ext == "svg" {
		return "images"
	}
	return ext
}

func htmlPage(siteID string, i int) []byte {
	title := fmt.Sprintf("Verification page %05d for %s", i+1, siteID)
	base := fmt.Sprintf(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>%s</title><link rel="stylesheet" href="../../assets/styles/site.css"></head>
<body><main><h1>%s</h1><p>verification fixture page html-index-%05d searchable content for %s.</p><p><a href="../../assets/downloads/summary%%20%%3Fmode%%3Dfull+text.txt">Read the deterministic resource</a> · <a href="../../assets/locale/%%E6%%97%%A5%%E6%%9C%%AC%%E8%%AA%%9E/version%%2525.dat">Read the Unicode resource</a></p><img src="../../assets/images/branding%%20%%231.svg" alt="Generated mark"><script src="../../assets/scripts/runtime.js"></script>
`, title, title, i+1, siteID)
	return []byte(withHTMLPadding(base, 256+[]int{0, 128, 768, 1792}[i%4], siteID, i))
}

func markdownPage(siteID string, i int) []byte {
	base := fmt.Sprintf(`# Verification page %05d for %s

This Markdown source includes verification fixture markdown-index-%05d and searchable content for %s.

[A generated static resource](../../assets/styles/site.css)

## Stable content

The generator writes deterministic pages so publisher scans can be repeated against the same input.
`, i+1, siteID, i+1, siteID)
	target := 256 + []int{0, 128, 768, 1792}[i%4]
	for len(base) < target {
		base += fmt.Sprintf("\nRepeated deterministic verification text for %s page %05d supports full-text indexing and size variation.\n", siteID, i+1)
	}
	return []byte(base)
}

func withHTMLPadding(base string, target int, siteID string, i int) string {
	for len(base) < target {
		base += fmt.Sprintf("<p>Repeated deterministic verification text for %s page %05d supports full-text indexing and size variation.</p>\n", siteID, i+1)
	}
	return base + "</main></body></html>\n"
}

func resource(siteID string, i int) []byte {
	ext := resourceExtensions[i%len(resourceExtensions)]
	target := []int{128, 512, 1024, 2048, 4096}[i%5]
	marker := fmt.Sprintf("verification fixture resource-%05d for %s", i+1, siteID)
	switch ext {
	case "css":
		return []byte(padResource(fmt.Sprintf("/* %s */\n:root { --fixture-marker: \"%s\"; }\nbody { font-family: sans-serif; }\n", marker, siteID), target, marker, "/* %s */\n"))
	case "js":
		return []byte(padResource(fmt.Sprintf("// %s\nexport const fixtureSite = %q;\n", marker, siteID), target, marker, "// %s\n"))
	case "json":
		text := strings.Repeat(marker+" ", max(1, (target-len(marker)-32)/(len(marker)+1)))
		encoded, _ := json.Marshal(struct {
			Site     string `json:"site"`
			Sequence int    `json:"sequence"`
			Content  string `json:"content"`
		}{siteID, i + 1, text})
		return append(encoded, '\n')
	case "svg":
		base := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 40"><title>%s</title><rect width="160" height="40" fill="#203040"/><text x="8" y="26" fill="white">fixture %05d</text></svg>`, marker, i+1)
		return []byte(padResource(base, target, marker, "<!-- %s -->"))
	case "txt":
		return []byte(padResource(marker+"\n", target, marker, "%s\n"))
	default:
		return []byte(padResource(marker+"\n", target, marker, "%s\n"))
	}
}

func padResource(base string, target int, marker, wrapper string) string {
	for len(base) < target {
		base += fmt.Sprintf(wrapper, marker)
	}
	return base
}

func checkFiles(root string, expected map[string][]byte) error {
	missing, changed := 0, 0
	for relative, want := range expected {
		actual, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if errors.Is(err, os.ErrNotExist) {
			missing++
			continue
		}
		if err != nil {
			return fmt.Errorf("read %q: %w", relative, err)
		}
		if !bytes.Equal(actual, want) {
			changed++
		}
	}
	actualPaths := make(map[string]bool, len(expected))
	if err := filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) && filePath == root {
				return nil
			}
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, filePath)
		if err != nil {
			return err
		}
		actualPaths[filepath.ToSlash(relative)] = true
		return nil
	}); err != nil {
		return fmt.Errorf("walk generated files: %w", err)
	}
	extra := 0
	for relative := range actualPaths {
		if _, ok := expected[relative]; !ok {
			extra++
		}
	}
	if missing != 0 || changed != 0 || extra != 0 || len(actualPaths) != len(expected) {
		return fmt.Errorf("content mismatch: expected %d files, found %d (%d missing, %d changed, %d extra)", len(expected), len(actualPaths), missing, changed, extra)
	}
	return nil
}

func writeFiles(root string, expected map[string][]byte) error {
	if err := os.MkdirAll(root, 0o755); err != nil {
		return fmt.Errorf("create source directory: %w", err)
	}
	for relative, contents := range expected {
		filePath := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			return fmt.Errorf("create directory for %q: %w", relative, err)
		}
		if err := os.WriteFile(filePath, contents, 0o644); err != nil {
			return fmt.Errorf("write %q: %w", relative, err)
		}
	}
	var stale []string
	if err := filepath.WalkDir(root, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, filePath)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if _, ok := expected[relative]; !ok {
			stale = append(stale, filePath)
		}
		return nil
	}); err != nil {
		return fmt.Errorf("find stale generated files: %w", err)
	}
	for _, filePath := range stale {
		if err := os.Remove(filePath); err != nil {
			return fmt.Errorf("remove stale file %q: %w", filePath, err)
		}
	}
	return nil
}

func sortedKeys(values map[string][]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "scale-fixtures: "+format+"\n", args...)
	os.Exit(1)
}
