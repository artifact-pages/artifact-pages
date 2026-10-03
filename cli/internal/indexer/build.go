package indexer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tasuku43/git-artifact-pages/cli/internal/fulltext"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/extension"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
	"golang.org/x/net/html"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

var siteIDPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

// ValidateUTF8RelativePath rejects source paths that cannot be represented
// faithfully in the site's JSON index and storage projection.
func ValidateUTF8RelativePath(relative string) error {
	if !utf8.ValidString(relative) {
		return fmt.Errorf("path %q is not valid UTF-8", relative)
	}
	return nil
}

type BuildOptions struct {
	SiteID          string
	SiteTitle       string
	SiteDescription string
	SourceDir       string
	OutputDir       string
	Repository      string
	RepositoryURL   string
	Ref             string
	// InputPolicy is a caller-owned version string for projection inputs that
	// affect published bytes but are outside the indexer's own schema.
	InputPolicy    string
	RejectSymlinks bool
	Now            func() time.Time
}

type BuildResult struct {
	SearchFiles      []string
	SearchBytes      int
	FilesScanned     int
	ArtifactsIndexed int
	OutputPath       string
	OutputBytes      int
	MetadataPath     string
	MetadataBytes    int
	Elapsed          time.Duration
}

// GitSourceIdentity describes the GitHub repository and repository-relative
// source directory used by registered-site publisher eligibility checks.
type GitSourceIdentity struct {
	Repository    string
	RepositoryURL string
	SourcePath    string
	Root          string
}

type SiteIndex struct {
	SchemaVersion         int                    `json:"schemaVersion"`
	Site                  SiteSummary            `json:"site"`
	GeneratedAt           string                 `json:"generatedAt"`
	Artifacts             []ArtifactIndexEntry   `json:"artifacts"`
	PaletteScoringProfile *PaletteScoringProfile `json:"paletteScoringProfile,omitempty"`
}

type SiteDiscoveryMetadata struct {
	FullTextURL      string      `json:"fullTextUrl,omitempty"`
	SchemaVersion    int         `json:"schemaVersion"`
	Site             SiteSummary `json:"site"`
	GeneratedAt      string      `json:"generatedAt"`
	ArtifactCount    int         `json:"artifactCount"`
	ArtifactIndexURL string      `json:"artifactIndexUrl"`
}

type SiteSummary struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description,omitempty"`
}

type ArtifactIndexEntry struct {
	ID            string             `json:"id"`
	Title         string             `json:"title"`
	Path          string             `json:"path"`
	Format        string             `json:"format"`
	Filename      string             `json:"filename,omitempty"`
	ArtifactURL   string             `json:"artifactUrl"`
	UpdatedAt     string             `json:"updatedAt"`
	LastCommitter *ArtifactCommitter `json:"lastCommitter,omitempty"`
	Source        *ArtifactSource    `json:"source,omitempty"`
	TOC           []TOCEntry         `json:"toc,omitempty"`
}

type ArtifactCommitter struct {
	Name string `json:"name"`
}

type ArtifactSource struct {
	Repository    string `json:"repository"`
	RepositoryURL string `json:"repositoryUrl,omitempty"`
	Ref           string `json:"ref"`
	FilePath      string `json:"filePath"`
}

type TOCEntry struct {
	Level int    `json:"level"`
	Text  string `json:"text"`
	ID    string `json:"id"`
}

type discoveredArtifact struct {
	directory         string
	directoryRelative string
	relative          string
	file              string
	fileRelative      string
	filename          string
}

type gitMetadata struct {
	repository    string
	repositoryURL string
	ref           string
}

type artifactGitUpdate struct {
	updatedAt     time.Time
	lastCommitter string
}

func Build(ctx context.Context, options BuildOptions) (BuildResult, error) {
	startedAt := time.Now()
	prepared, err := PrepareBuild(ctx, options)
	if err != nil {
		return BuildResult{}, err
	}
	result, err := BuildPrepared(ctx, prepared, prepared.outputRoot)
	if err == nil {
		result.Elapsed = time.Since(startedAt)
	}
	return result, err
}

// BuildPrepared generates the index and search projection from the
// exact files and Git metadata captured by PrepareBuild. outputDir may differ
// from the preparation default, but the source snapshot and build options are
// fixed.
func BuildPrepared(ctx context.Context, prepared *PreparedBuild, outputDir string) (BuildResult, error) {
	startedAt := time.Now()
	if prepared == nil {
		return BuildResult{}, errors.New("prepared site build is required")
	}
	options := prepared.options
	outputRoot := outputDir
	if outputRoot == "" {
		outputRoot = prepared.outputRoot
	}
	if !filepath.IsAbs(outputRoot) {
		workingDir, err := os.Getwd()
		if err != nil {
			return BuildResult{}, fmt.Errorf("get current directory: %w", err)
		}
		outputRoot = filepath.Join(workingDir, outputRoot)
	}
	outputRoot, err := filepath.Abs(outputRoot)
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve output directory: %w", err)
	}
	if filepath.Clean(outputRoot) == filepath.Clean(prepared.options.SourceDir) {
		return BuildResult{}, errors.New("output directory cannot be the artifact source directory")
	}
	indexTime := prepared.indexTime
	relativeSource := prepared.relativeSource
	gitInfo := prepared.gitInfo
	scannedFiles := prepared.scannedFiles

	title := strings.TrimSpace(options.SiteTitle)
	if title == "" {
		title = humanize(path.Base(options.SiteID))
	}

	description := options.SiteDescription
	if strings.TrimSpace(description) == "" {
		description = ""
	}
	index := SiteIndex{
		SchemaVersion: 1,
		Site:          SiteSummary{ID: options.SiteID, Title: title, Description: description},
		GeneratedAt:   indexTime.UTC().Format(time.RFC3339),
		Artifacts:     make([]ArtifactIndexEntry, 0, len(prepared.documents)),
	}
	searchRecords := make([]fulltext.Record, 0)
	for _, document := range prepared.documents {
		artifact := document.artifact
		sourceFile := prepared.fileByRelative[artifact.relative]
		metadata, searchText, err := readArtifactWithSearchBytes(sourceFile.bytes, artifact.filename)
		if err != nil {
			return BuildResult{}, fmt.Errorf("parse artifact %q: %w", artifact.relative, err)
		}
		artifactTitle := metadata.title
		if artifactTitle == "" {
			artifactTitle = fallbackArtifactTitle(artifact)
		}

		updatedAt := document.updatedAt

		entry := ArtifactIndexEntry{
			ID:          artifact.relative,
			Title:       artifactTitle,
			Path:        artifact.relative,
			Format:      artifactFormat(artifact.filename),
			Filename:    artifact.filename,
			ArtifactURL: artifactURL(options.SiteID, artifact.fileRelative),
			UpdatedAt:   updatedAt.UTC().Format(time.RFC3339),
			TOC:         metadata.toc,
		}
		if document.lastCommitter != "" {
			entry.LastCommitter = &ArtifactCommitter{Name: document.lastCommitter}
		}
		if gitInfo.repository != "" {
			repositoryFilePath := artifact.relative
			if relativeSource != "." {
				repositoryFilePath = path.Join(relativeSource, artifact.relative)
			}
			entry.Source = &ArtifactSource{
				Repository:    gitInfo.repository,
				RepositoryURL: gitInfo.repositoryURL,
				Ref:           gitInfo.ref,
				FilePath:      repositoryFilePath,
			}
		}
		index.Artifacts = append(index.Artifacts, entry)
		searchRecords = append(searchRecords, fulltext.Record{Path: entry.Path, Text: entry.Title + " " + searchText})
	}
	sort.Slice(index.Artifacts, func(i, j int) bool {
		return index.Artifacts[i].ID < index.Artifacts[j].ID
	})
	if len(index.Artifacts) >= paletteScoringProfileThreshold {
		profile := buildPaletteScoringProfile(index.Artifacts)
		index.PaletteScoringProfile = &profile
	}

	projection, err := fulltext.Build(ctx, options.SiteID, searchRecords)
	if err != nil {
		return BuildResult{}, fmt.Errorf("build full-text index: %w", err)
	}
	var searchFiles []string
	searchBytes := 0
	// Publish all immutable bytes locally before exposing the manifest.
	for name := range projection.Files {
		if name != "manifest.json" {
			searchFiles = append(searchFiles, name)
		}
	}
	sort.Strings(searchFiles)
	searchFiles = append(searchFiles, "manifest.json")
	for i, name := range searchFiles {
		filename := filepath.Join(outputRoot, "_indexes", options.SiteID, "search", name)
		if err := writeAtomically(filename, projection.Files[name]); err != nil {
			return BuildResult{}, fmt.Errorf("write full-text index: %w", err)
		}
		searchBytes += len(projection.Files[name])
		searchFiles[i] = filename
	}
	serialized, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return BuildResult{}, fmt.Errorf("encode site index: %w", err)
	}
	serialized = append(serialized, '\n')
	indexPath := filepath.Join(outputRoot, "_indexes", options.SiteID, "index.json")
	if err := writeAtomically(indexPath, serialized); err != nil {
		return BuildResult{}, fmt.Errorf("write site artifact index: %w", err)
	}
	metadata := SiteDiscoveryMetadata{
		SchemaVersion:    index.SchemaVersion,
		Site:             index.Site,
		GeneratedAt:      index.GeneratedAt,
		ArtifactCount:    len(index.Artifacts),
		ArtifactIndexURL: siteIndexURL(options.SiteID),
	}
	metadata.FullTextURL = "/_indexes/" + options.SiteID + "/search/manifest.json"
	metadataBytes, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return BuildResult{}, fmt.Errorf("encode site discovery metadata: %w", err)
	}
	metadataBytes = append(metadataBytes, '\n')
	metadataPath := filepath.Join(outputRoot, "_indexes", options.SiteID, "meta.json")
	if err := writeAtomically(metadataPath, metadataBytes); err != nil {
		return BuildResult{}, fmt.Errorf("write site discovery metadata: %w", err)
	}
	if err := pruneSearchFiles(filepath.Join(outputRoot, "_indexes", options.SiteID, "search"), searchFiles); err != nil {
		return BuildResult{}, fmt.Errorf("remove stale local search data: %w", err)
	}

	return BuildResult{
		SearchFiles:      searchFiles,
		SearchBytes:      searchBytes,
		FilesScanned:     scannedFiles,
		ArtifactsIndexed: len(index.Artifacts),
		OutputPath:       indexPath,
		OutputBytes:      len(serialized),
		MetadataPath:     metadataPath,
		MetadataBytes:    len(metadataBytes),
		Elapsed:          time.Since(startedAt),
	}, nil
}

// ResolveGitSourceIdentity validates that sourceDir is inside the current Git
// working tree and resolves its canonical owner/repository identity from the
// origin remote. Branch names are intentionally not part of site identity.
func ResolveGitSourceIdentity(ctx context.Context, sourceDir string) (GitSourceIdentity, error) {
	if sourceDir == "" {
		return GitSourceIdentity{}, errors.New("source directory is required")
	}
	repository, repositoryURL, root, err := ResolveGitRepositoryIdentity(ctx)
	if err != nil {
		return GitSourceIdentity{}, err
	}
	workingDir, err := os.Getwd()
	if err != nil {
		return GitSourceIdentity{}, fmt.Errorf("get current directory: %w", err)
	}
	resolvedSource := sourceDir
	if !filepath.IsAbs(resolvedSource) {
		resolvedSource = filepath.Join(workingDir, resolvedSource)
	}
	resolvedSource, err = filepath.Abs(resolvedSource)
	if err != nil {
		return GitSourceIdentity{}, fmt.Errorf("resolve source directory: %w", err)
	}
	resolvedSource, err = filepath.EvalSymlinks(resolvedSource)
	if err != nil {
		return GitSourceIdentity{}, fmt.Errorf("resolve source directory: %w", err)
	}
	if err := ensureWithin(root, resolvedSource); err != nil {
		return GitSourceIdentity{}, fmt.Errorf("source directory must be inside the Git working tree: %w", err)
	}
	info, err := os.Stat(resolvedSource)
	if err != nil {
		return GitSourceIdentity{}, fmt.Errorf("read source directory: %w", err)
	}
	if !info.IsDir() {
		return GitSourceIdentity{}, errors.New("source path is not a directory")
	}
	relative, err := filepath.Rel(root, resolvedSource)
	if err != nil {
		return GitSourceIdentity{}, fmt.Errorf("resolve source path relative to Git working tree: %w", err)
	}
	sourcePath := filepath.ToSlash(relative)
	if sourcePath == "" {
		sourcePath = "."
	}
	return GitSourceIdentity{Repository: repository, RepositoryURL: repositoryURL, SourcePath: sourcePath, Root: root}, nil
}

// ResolveGitRepositoryIdentity resolves the current checkout's canonical
// GitHub origin and working-tree root without selecting a content directory.
func ResolveGitRepositoryIdentity(ctx context.Context) (repository, repositoryURL, root string, err error) {
	workingDir, err := os.Getwd()
	if err != nil {
		return "", "", "", fmt.Errorf("get current directory: %w", err)
	}
	root, err = gitOutput(ctx, workingDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", "", "", fmt.Errorf("source identity requires a Git working tree: %w", err)
	}
	root, err = filepath.EvalSymlinks(strings.TrimSpace(root))
	if err != nil {
		return "", "", "", fmt.Errorf("resolve Git working tree: %w", err)
	}
	remote, err := gitOutput(ctx, root, "config", "--get", "remote.origin.url")
	if err != nil {
		return "", "", "", errors.New("source Git repository must have a GitHub origin remote")
	}
	repository, repositoryURL = parseGitHubRepositoryRemote(strings.TrimSpace(remote))
	if repository == "" {
		return "", "", "", errors.New("source Git origin must identify a GitHub owner/repository")
	}
	return repository, repositoryURL, root, nil
}

func parseGitHubRepositoryRemote(remote string) (string, string) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", ""
	}

	var host, repositoryPath string
	if strings.Contains(remote, "://") {
		parsed, err := url.Parse(remote)
		if err != nil || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", ""
		}
		host = parsed.Hostname()
		repositoryPath = parsed.Path
	} else {
		separator := strings.Index(remote, ":")
		if separator < 0 {
			return "", ""
		}
		host = remote[:separator]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		repositoryPath = remote[separator+1:]
	}
	if !strings.EqualFold(host, "github.com") {
		return "", ""
	}

	repositoryPath = strings.Trim(strings.TrimPrefix(repositoryPath, "/"), "/")
	repositoryPath = strings.TrimSuffix(repositoryPath, ".git")
	parts := strings.Split(repositoryPath, "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", ""
	}
	repository := parts[0] + "/" + parts[1]
	return repository, "https://github.com/" + repository
}

func discoverArtifacts(sourcePath, outputRoot string) ([]discoveredArtifact, int, error) {
	artifacts := make([]discoveredArtifact, 0)
	routes := make(map[string]string)
	filesScanned := 0
	err := filepath.WalkDir(sourcePath, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentPath != sourcePath && entry.Name() == ".git" {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if currentPath != sourcePath && entry.IsDir() && pathWithin(outputRoot, currentPath) {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		filesScanned++
		if !isIndexedDocument(entry.Name()) {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("artifact entrypoint %q must not be a symlink", currentPath)
		}

		fileRelative, err := filepath.Rel(sourcePath, currentPath)
		if err != nil {
			return fmt.Errorf("resolve artifact file path %q: %w", currentPath, err)
		}
		fileRelative = filepath.ToSlash(fileRelative)
		if err := ValidateUTF8RelativePath(fileRelative); err != nil {
			return fmt.Errorf("artifact %w", err)
		}
		directory := filepath.Dir(currentPath)
		filename := entry.Name()
		directoryRelative, err := filepath.Rel(sourcePath, directory)
		if err != nil {
			return fmt.Errorf("resolve artifact path %q: %w", directory, err)
		}
		directoryRelative = filepath.ToSlash(directoryRelative)
		relative := fileRelative
		if previousFile, exists := routes[relative]; exists {
			return fmt.Errorf("documents %q and %q resolve to the same artifact path %q", previousFile, fileRelative, relative)
		}
		routes[relative] = fileRelative
		artifacts = append(artifacts, discoveredArtifact{
			directory:         directory,
			directoryRelative: directoryRelative,
			relative:          relative,
			file:              currentPath,
			fileRelative:      fileRelative,
			filename:          filename,
		})
		return nil
	})
	if err != nil {
		return nil, filesScanned, fmt.Errorf("scan source directory: %w", err)
	}
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].relative < artifacts[j].relative })
	return artifacts, filesScanned, nil
}

func isHTMLDocument(filename string) bool {
	switch strings.ToLower(filepath.Ext(filename)) {
	case ".html", ".htm":
		return true
	default:
		return false
	}
}

func isMarkdownDocument(filename string) bool {
	return strings.EqualFold(filepath.Ext(filename), ".md")
}

func isIndexedDocument(filename string) bool {
	return isHTMLDocument(filename) || isMarkdownDocument(filename)
}

func artifactFormat(filename string) string {
	if isMarkdownDocument(filename) {
		return "markdown"
	}
	return "html"
}

func fallbackArtifactTitle(artifact discoveredArtifact) string {
	return humanize(strings.TrimSuffix(artifact.filename, path.Ext(artifact.filename)))
}

type artifactHTMLMetadata struct {
	title   string
	firstH1 string
	toc     []TOCEntry
}

func readArtifactHTML(filename string) (artifactHTMLMetadata, error) {
	file, err := os.Open(filename)
	if err != nil {
		return artifactHTMLMetadata{}, err
	}
	defer file.Close()

	return readArtifactHTMLDocument(file)
}

func readArtifactMetadata(filename, basename string) (artifactHTMLMetadata, error) {
	if !isMarkdownDocument(basename) {
		return readArtifactHTML(filename)
	}

	source, err := os.ReadFile(filename)
	if err != nil {
		return artifactHTMLMetadata{}, err
	}
	document, err := renderMarkdownHTMLDocument(source)
	if err != nil {
		return artifactHTMLMetadata{}, err
	}
	metadata := readArtifactHTMLDocumentNode(document)
	metadata.title = metadata.firstH1
	return metadata, nil
}

func readArtifactWithSearch(filename, basename string) (artifactHTMLMetadata, string, error) {
	source, err := os.ReadFile(filename)
	if err != nil {
		return artifactHTMLMetadata{}, "", err
	}
	return readArtifactWithSearchBytes(source, basename)
}

func readArtifactWithSearchBytes(source []byte, basename string) (artifactHTMLMetadata, string, error) {
	var document *html.Node
	var err error
	if isMarkdownDocument(basename) {
		document, err = renderMarkdownHTMLDocument(source)
	} else {
		document, err = html.Parse(bytes.NewReader(source))
	}
	if err != nil {
		return artifactHTMLMetadata{}, "", err
	}
	metadata := readArtifactHTMLDocumentNode(document)
	if isMarkdownDocument(basename) {
		metadata.title = metadata.firstH1
	}
	return metadata, fulltext.ExtractText(document), nil
}

// Only remove files owned by this format, after the new metadata is visible.
func pruneSearchFiles(directory string, files []string) error {
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	keep := make(map[string]bool)
	for _, filename := range files {
		keep[filepath.Base(filename)] = true
	}
	owned := regexp.MustCompile(`^(root|leaf)-[a-f0-9]{64}\.gz$`)
	for _, entry := range entries {
		if !entry.IsDir() && !keep[entry.Name()] && (entry.Name() == "manifest.json" || owned.MatchString(entry.Name())) {
			if err := os.Remove(filepath.Join(directory, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func renderMarkdownHTMLDocument(source []byte) (*html.Node, error) {
	markdown := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithRendererOptions(goldmarkhtml.WithUnsafe()),
	)
	var rendered bytes.Buffer
	if err := markdown.Convert(source, &rendered); err != nil {
		return nil, err
	}
	document, err := html.Parse(&rendered)
	if err != nil {
		return nil, err
	}
	assignMarkdownHeadingIDs(document)
	return document, nil
}

func readArtifactHTMLDocument(source io.Reader) (artifactHTMLMetadata, error) {
	document, err := html.Parse(source)
	if err != nil {
		return artifactHTMLMetadata{}, err
	}
	return readArtifactHTMLDocumentNode(document), nil
}

func assignMarkdownHeadingIDs(document *html.Node) {
	occurrences := make(map[string]int)
	// Reserve raw HTML IDs on every element before generating heading slugs.
	var reserveExplicitIDs func(*html.Node)
	reserveExplicitIDs = func(node *html.Node) {
		if node.Type == html.ElementNode {
			if id := htmlAttribute(node, "id"); id != "" {
				occurrences[id] = 0
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			reserveExplicitIDs(child)
		}
	}
	reserveExplicitIDs(document)

	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if markdownHeadingRank(node) > 0 {
			id := htmlAttribute(node, "id")
			if id == "" {
				base := githubHeadingSlug(markdownHeadingText(node))
				id = base
				if count, exists := occurrences[base]; exists {
					count++
					occurrences[base] = count
					id = base + "-" + strconv.Itoa(count)
					for {
						if _, exists := occurrences[id]; !exists {
							break
						}
						count++
						occurrences[base] = count
						id = base + "-" + strconv.Itoa(count)
					}
				}
				occurrences[id] = 0
			}
			setHTMLAttribute(node, "id", "md-"+id)
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(document)
}

func markdownHeadingRank(node *html.Node) int {
	if node.Type != html.ElementNode || len(node.Data) != 2 || node.Data[0] != 'h' || node.Data[1] < '1' || node.Data[1] > '6' {
		return 0
	}
	return int(node.Data[1] - '0')
}

func htmlAttribute(node *html.Node, name string) string {
	for _, attribute := range node.Attr {
		if attribute.Key == name {
			return attribute.Val
		}
	}
	return ""
}

func setHTMLAttribute(node *html.Node, name, value string) {
	for index := range node.Attr {
		if node.Attr[index].Key == name {
			node.Attr[index].Val = value
			return
		}
	}
	node.Attr = append(node.Attr, html.Attribute{Key: name, Val: value})
}

func markdownHeadingText(node *html.Node) string {
	var text strings.Builder
	var visit func(*html.Node)
	visit = func(current *html.Node) {
		if current.Type == html.TextNode {
			text.WriteString(current.Data)
			return
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(node)
	return text.String()
}

func githubHeadingSlug(value string) string {
	var slug strings.Builder
	for _, character := range cases.Lower(language.Und).String(value) {
		if character == ' ' {
			slug.WriteByte('-')
		} else if githubSluggerCharacterAllowed(character) {
			slug.WriteRune(character)
		}
	}
	return slug.String()
}

func readArtifactHTMLDocumentNode(document *html.Node) artifactHTMLMetadata {
	metadata := artifactHTMLMetadata{toc: make([]TOCEntry, 0)}
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if node.Type == html.ElementNode && node.Data == "title" && metadata.title == "" {
			metadata.title = normalizedText(node)
		}
		if level := markdownHeadingRank(node); level >= 1 && level <= 3 {
			id := strings.TrimSpace(htmlAttribute(node, "id"))
			text := normalizedText(node)
			if level == 1 && metadata.firstH1 == "" {
				metadata.firstH1 = text
			}
			if id != "" && text != "" {
				metadata.toc = append(metadata.toc, TOCEntry{Level: level, Text: text, ID: id})
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(document)
	return metadata
}

func normalizedText(node *html.Node) string {
	var text strings.Builder
	var visit func(*html.Node)
	visit = func(current *html.Node) {
		if current.Type == html.ElementNode && (current.Data == "script" || current.Data == "style") {
			return
		}
		if current.Type == html.TextNode {
			text.WriteString(current.Data)
			text.WriteByte(' ')
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(node)
	return strings.Join(strings.Fields(text.String()), " ")
}

func artifactGitUpdates(ctx context.Context, repositoryRoot, sourcePath string, artifacts []discoveredArtifact) (map[string]artifactGitUpdate, error) {
	artifactDirectories, artifactFiles := artifactPathLookup(artifacts)

	pathspec := sourcePath
	if pathspec == "" {
		pathspec = "."
	}
	command := exec.CommandContext(ctx, "git", "log", "-z", "--format=%ct%x1f%cn", "--name-only", "--no-renames", "--", filepath.FromSlash(pathspec))
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("read Git history for source directory: %w: %s", err, strings.TrimSpace(string(output)))
	}

	latestByArtifact := make(map[string]artifactGitUpdate, len(artifacts))
	documentHistory := make(map[string]struct{}, len(artifactFiles))
	parts := bytes.Split(output, []byte{0})
	var currentCommitTime time.Time
	var currentCommitter string
	for index, part := range parts {
		value := string(part)
		header := bytes.Split(part, []byte{0x1f})
		if len(header) == 2 && len(parts) > index+1 && bytes.HasPrefix(parts[index+1], []byte{'\n'}) {
			if seconds, parseErr := strconv.ParseInt(string(header[0]), 10, 64); parseErr == nil {
				currentCommitTime = time.Unix(seconds, 0).UTC()
				currentCommitter = string(header[1])
			}
			continue
		}
		if currentCommitTime.IsZero() {
			continue
		}
		value = strings.TrimPrefix(value, "\n")
		if value == "" {
			continue
		}
		relativeFile := filepath.ToSlash(filepath.Clean(value))
		if sourcePath != "." {
			prefix := strings.TrimSuffix(sourcePath, "/") + "/"
			if !strings.HasPrefix(relativeFile, prefix) {
				continue
			}
			relativeFile = strings.TrimPrefix(relativeFile, prefix)
		}
		if artifactPath, isArtifactFile := artifactFiles[relativeFile]; isArtifactFile {
			documentHistory[artifactPath] = struct{}{}
		}
		for _, artifactPath := range artifactPathsForFile(relativeFile, artifactDirectories, artifactFiles) {
			update := latestByArtifact[artifactPath]
			if currentCommitTime.After(update.updatedAt) {
				update.updatedAt = currentCommitTime
				update.lastCommitter = currentCommitter
				latestByArtifact[artifactPath] = update
			}
		}
	}
	for _, artifact := range artifacts {
		if _, hasDocumentHistory := documentHistory[artifact.relative]; !hasDocumentHistory {
			delete(latestByArtifact, artifact.relative)
		}
	}
	return latestByArtifact, nil
}

func artifactWorkingTreeUpdates(ctx context.Context, repositoryRoot, sourcePath string, artifacts []discoveredArtifact, deletedAt time.Time) (map[string]time.Time, error) {
	artifactDirectories, artifactFiles := artifactPathLookup(artifacts)

	command := exec.CommandContext(ctx, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", filepath.FromSlash(sourcePath))
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("read Git working-tree changes for source directory: %w: %s", err, strings.TrimSpace(string(output)))
	}

	latestByArtifact := make(map[string]time.Time)
	for _, part := range bytes.Split(output, []byte{0}) {
		record := string(part)
		if len(record) < 4 || record[2] != ' ' {
			continue
		}
		file := filepath.ToSlash(filepath.Clean(filepath.FromSlash(record[3:])))
		if sourcePath != "." {
			prefix := strings.TrimSuffix(sourcePath, "/") + "/"
			if !strings.HasPrefix(file, prefix) {
				continue
			}
			file = strings.TrimPrefix(file, prefix)
		}
		artifactPaths := artifactPathsForFile(file, artifactDirectories, artifactFiles)
		if len(artifactPaths) == 0 {
			continue
		}

		updatedAt := deletedAt
		filePath := filepath.Join(repositoryRoot, filepath.FromSlash(record[3:]))
		if info, statErr := os.Stat(filePath); statErr == nil {
			updatedAt = info.ModTime()
		}
		for _, artifactPath := range artifactPaths {
			if updatedAt.After(latestByArtifact[artifactPath]) {
				latestByArtifact[artifactPath] = updatedAt
			}
		}
	}
	return latestByArtifact, nil
}

func artifactPathLookup(artifacts []discoveredArtifact) (map[string][]string, map[string]string) {
	byDirectory := make(map[string][]string, len(artifacts))
	byFile := make(map[string]string, len(artifacts))
	for _, artifact := range artifacts {
		byDirectory[artifact.directoryRelative] = append(byDirectory[artifact.directoryRelative], artifact.relative)
		byFile[artifact.fileRelative] = artifact.relative
	}
	return byDirectory, byFile
}

func artifactPathsForFile(relativeFile string, artifactDirectories map[string][]string, artifactFiles map[string]string) []string {
	if artifactPath, exists := artifactFiles[relativeFile]; exists {
		return []string{artifactPath}
	}
	directory := path.Dir(relativeFile)
	for directory != "." && directory != "/" {
		if artifactPaths, exists := artifactDirectories[directory]; exists {
			return artifactPaths
		}
		parent := path.Dir(directory)
		if parent == directory {
			break
		}
		directory = parent
	}
	if artifactPaths, exists := artifactDirectories["."]; exists {
		return artifactPaths
	}
	return nil
}

func latestArtifactFileModTime(directory string) (time.Time, error) {
	var latest time.Time
	err := filepath.WalkDir(directory, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			if currentPath != directory && entry.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.ModTime().After(latest) {
			latest = info.ModTime()
		}
		return nil
	})
	if err != nil {
		return time.Time{}, err
	}
	if latest.IsZero() {
		return time.Time{}, fmt.Errorf("artifact directory %q contains no files", directory)
	}
	return latest, nil
}

func resolveGitMetadata(ctx context.Context, repositoryRoot string, options BuildOptions) gitMetadata {
	remote, _ := gitOutput(ctx, repositoryRoot, "config", "--get", "remote.origin.url")
	remoteRepository, remoteURL := parseRepositoryRemote(strings.TrimSpace(remote))
	metadata := gitMetadata{repository: remoteRepository, repositoryURL: remoteURL}
	if options.Repository != "" {
		metadata.repository = strings.TrimSpace(options.Repository)
	}
	if options.RepositoryURL != "" {
		metadata.repositoryURL = strings.TrimSpace(options.RepositoryURL)
	}
	if metadata.repository == "" && metadata.repositoryURL != "" {
		metadata.repository, _ = parseRepositoryRemote(metadata.repositoryURL)
	}
	if metadata.ref == "" {
		metadata.ref, _ = gitOutput(ctx, repositoryRoot, "symbolic-ref", "--quiet", "--short", "HEAD")
		metadata.ref = strings.TrimSpace(metadata.ref)
	}
	if options.Ref != "" {
		metadata.ref = strings.TrimSpace(options.Ref)
	}
	if metadata.ref == "" {
		metadata.ref, _ = gitOutput(ctx, repositoryRoot, "rev-parse", "--short", "HEAD")
		metadata.ref = strings.TrimSpace(metadata.ref)
	}
	return metadata
}

func parseRepositoryRemote(remote string) (string, string) {
	remote = strings.TrimSpace(remote)
	if remote == "" {
		return "", ""
	}

	var host, repositoryPath string
	if strings.Contains(remote, "://") {
		parsed, err := url.Parse(remote)
		if err != nil || parsed.Hostname() == "" {
			return "", ""
		}
		host = parsed.Hostname()
		repositoryPath = parsed.Path
	} else {
		separator := strings.Index(remote, ":")
		if separator < 0 {
			return "", ""
		}
		host = remote[:separator]
		if at := strings.LastIndex(host, "@"); at >= 0 {
			host = host[at+1:]
		}
		repositoryPath = remote[separator+1:]
	}

	repositoryPath = strings.TrimSuffix(strings.TrimPrefix(repositoryPath, "/"), ".git")
	parts := strings.Split(strings.Trim(repositoryPath, "/"), "/")
	if len(parts) < 2 || parts[len(parts)-1] == "" || parts[len(parts)-2] == "" {
		return "", ""
	}
	repository := parts[len(parts)-2] + "/" + parts[len(parts)-1]
	canonicalURL := ""
	if host != "" {
		canonicalURL = "https://" + host + "/" + strings.Join(parts, "/")
	}
	return repository, canonicalURL
}

func gitOutput(ctx context.Context, directory string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = directory
	output, err := command.Output()
	if err != nil {
		return "", err
	}
	return string(output), nil
}

func artifactURL(siteID, artifactPath string) string {
	segments := []string{"_artifacts", siteID}
	for _, segment := range strings.Split(artifactPath, "/") {
		segments = append(segments, url.PathEscape(segment))
	}
	return "/" + strings.Join(segments, "/")
}

func siteIndexURL(siteID string) string {
	return "/_indexes/" + url.PathEscape(siteID) + "/index.json"
}

func humanize(value string) string {
	value = strings.ReplaceAll(value, "-", " ")
	value = strings.ReplaceAll(value, "_", " ")
	words := strings.Fields(value)
	for index, word := range words {
		firstRune, size := utf8.DecodeRuneInString(word)
		if size > 0 {
			words[index] = strings.ToUpper(string(firstRune)) + word[size:]
		}
	}
	return strings.Join(words, " ")
}

func writeAtomically(filename string, contents []byte) error {
	directory := filepath.Dir(filename)
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".index-*.tmp")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(contents); err != nil {
		temporary.Close()
		return err
	}
	// os.CreateTemp creates 0600 files; generated indexes are served by a web
	// server that may run as another user, so make them world-readable.
	if err := temporary.Chmod(0o644); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryName, filename)
}

func ensureWithin(root, candidate string) error {
	relative, err := filepath.Rel(root, candidate)
	if err != nil {
		return err
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return fmt.Errorf("%q is outside %q", candidate, root)
	}
	return nil
}

func pathWithin(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}
