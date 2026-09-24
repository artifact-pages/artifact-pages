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
	"unicode"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	goldmarkhtml "github.com/yuin/goldmark/renderer/html"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
	"golang.org/x/net/html"
)

var siteIDPattern = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`)

type BuildOptions struct {
	SiteID        string
	SiteTitle     string
	SourceDir     string
	OutputDir     string
	Repository    string
	RepositoryURL string
	Ref           string
	Now           func() time.Time
}

type BuildResult struct {
	FilesScanned     int
	ArtifactsIndexed int
	OutputPath       string
	OutputBytes      int
	MetadataPath     string
	MetadataBytes    int
	Elapsed          time.Duration
}

type SiteIndex struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Site          SiteSummary          `json:"site"`
	GeneratedAt   string               `json:"generatedAt"`
	Artifacts     []ArtifactIndexEntry `json:"artifacts"`
}

type SiteDiscoveryMetadata struct {
	SchemaVersion    int         `json:"schemaVersion"`
	Site             SiteSummary `json:"site"`
	GeneratedAt      string      `json:"generatedAt"`
	ArtifactCount    int         `json:"artifactCount"`
	ArtifactIndexURL string      `json:"artifactIndexUrl"`
}

type SiteSummary struct {
	ID    string `json:"id"`
	Title string `json:"title"`
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
	if !siteIDPattern.MatchString(options.SiteID) {
		return BuildResult{}, fmt.Errorf("invalid site identifier %q: use lowercase letters, numbers, and internal hyphens", options.SiteID)
	}
	if options.SourceDir == "" {
		return BuildResult{}, errors.New("source directory is required")
	}
	if options.OutputDir == "" {
		options.OutputDir = ".local/storage"
	}
	indexTime := time.Now()
	if options.Now != nil {
		indexTime = options.Now()
	}

	workingDir, err := os.Getwd()
	if err != nil {
		return BuildResult{}, fmt.Errorf("get current directory: %w", err)
	}
	repositoryRoot, err := gitOutput(ctx, workingDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return BuildResult{}, fmt.Errorf("index builds must run inside a Git working tree: %w", err)
	}
	repositoryRoot, err = filepath.EvalSymlinks(strings.TrimSpace(repositoryRoot))
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve Git working tree: %w", err)
	}

	sourcePath := options.SourceDir
	if !filepath.IsAbs(sourcePath) {
		sourcePath = filepath.Join(workingDir, sourcePath)
	}
	sourcePath, err = filepath.Abs(sourcePath)
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve source directory: %w", err)
	}
	sourcePath, err = filepath.EvalSymlinks(sourcePath)
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve source directory %q: %w", options.SourceDir, err)
	}
	if err := ensureWithin(repositoryRoot, sourcePath); err != nil {
		return BuildResult{}, fmt.Errorf("source directory must be inside the Git working tree: %w", err)
	}
	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return BuildResult{}, fmt.Errorf("read source directory: %w", err)
	}
	if !sourceInfo.IsDir() {
		return BuildResult{}, fmt.Errorf("source path %q is not a directory", options.SourceDir)
	}

	outputRoot := options.OutputDir
	if !filepath.IsAbs(outputRoot) {
		outputRoot = filepath.Join(workingDir, outputRoot)
	}
	outputRoot, err = filepath.Abs(outputRoot)
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve output directory: %w", err)
	}
	if filepath.Clean(outputRoot) == filepath.Clean(sourcePath) {
		return BuildResult{}, errors.New("output directory cannot be the artifact source directory")
	}

	artifacts, scannedFiles, err := discoverArtifacts(sourcePath, outputRoot)
	if err != nil {
		return BuildResult{}, err
	}
	if len(artifacts) == 0 {
		return BuildResult{}, fmt.Errorf("no HTML or Markdown artifacts found in %q", options.SourceDir)
	}

	relativeSource, err := filepath.Rel(repositoryRoot, sourcePath)
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve source path relative to Git working tree: %w", err)
	}
	relativeSource = filepath.ToSlash(relativeSource)
	gitUpdatesByArtifact, err := artifactGitUpdates(ctx, repositoryRoot, relativeSource, artifacts)
	if err != nil {
		return BuildResult{}, err
	}
	workingTreeUpdates, err := artifactWorkingTreeUpdates(ctx, repositoryRoot, relativeSource, artifacts, indexTime)
	if err != nil {
		return BuildResult{}, err
	}
	gitInfo := resolveGitMetadata(ctx, repositoryRoot, options)

	title := strings.TrimSpace(options.SiteTitle)
	if title == "" {
		title = humanize(path.Base(options.SiteID))
	}

	index := SiteIndex{
		SchemaVersion: 1,
		Site:          SiteSummary{ID: options.SiteID, Title: title},
		GeneratedAt:   indexTime.UTC().Format(time.RFC3339),
		Artifacts:     make([]ArtifactIndexEntry, 0, len(artifacts)),
	}
	modTimeByDirectory := make(map[string]time.Time)
	for _, artifact := range artifacts {
		metadata, err := readArtifactMetadata(artifact.file, artifact.filename)
		if err != nil {
			return BuildResult{}, fmt.Errorf("parse artifact %q: %w", artifact.relative, err)
		}
		artifactTitle := metadata.title
		if artifactTitle == "" {
			artifactTitle = fallbackArtifactTitle(artifact)
		}

		gitUpdate := gitUpdatesByArtifact[artifact.relative]
		updatedAt, found := gitUpdate.updatedAt, !gitUpdate.updatedAt.IsZero()
		if workingTreeTime, hasWorkingTreeUpdate := workingTreeUpdates[artifact.relative]; hasWorkingTreeUpdate && (!found || workingTreeTime.After(updatedAt)) {
			updatedAt = workingTreeTime
			found = true
		}
		if !found {
			updatedAt, found = modTimeByDirectory[artifact.directory]
			if !found {
				updatedAt, err = latestArtifactFileModTime(artifact.directory)
				if err != nil {
					return BuildResult{}, fmt.Errorf("read modification time for artifact %q: %w", artifact.relative, err)
				}
				modTimeByDirectory[artifact.directory] = updatedAt
			}
		}

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
		if gitUpdate.lastCommitter != "" {
			entry.LastCommitter = &ArtifactCommitter{Name: gitUpdate.lastCommitter}
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
	}
	sort.Slice(index.Artifacts, func(i, j int) bool {
		return index.Artifacts[i].ID < index.Artifacts[j].ID
	})

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
	metadataBytes, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return BuildResult{}, fmt.Errorf("encode site discovery metadata: %w", err)
	}
	metadataBytes = append(metadataBytes, '\n')
	metadataPath := filepath.Join(outputRoot, "_indexes", options.SiteID, "meta.json")
	if err := writeAtomically(metadataPath, metadataBytes); err != nil {
		return BuildResult{}, fmt.Errorf("write site discovery metadata: %w", err)
	}

	return BuildResult{
		FilesScanned:     scannedFiles,
		ArtifactsIndexed: len(index.Artifacts),
		OutputPath:       indexPath,
		OutputBytes:      len(serialized),
		MetadataPath:     metadataPath,
		MetadataBytes:    len(metadataBytes),
		Elapsed:          time.Since(startedAt),
	}, nil
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
	markdown := goldmark.New(
		goldmark.WithExtensions(extension.GFM),
		goldmark.WithRendererOptions(goldmarkhtml.WithUnsafe()),
		goldmark.WithParserOptions(
			parser.WithAutoHeadingID(),
			parser.WithASTTransformers(util.Prioritized(&githubHeadingIDTransformer{}, 100)),
		),
	)
	var rendered bytes.Buffer
	if err := markdown.Convert(source, &rendered); err != nil {
		return artifactHTMLMetadata{}, err
	}
	metadata, err := readArtifactHTMLDocument(&rendered)
	if err != nil {
		return artifactHTMLMetadata{}, err
	}
	metadata.title = metadata.firstH1
	for index := range metadata.toc {
		metadata.toc[index].ID = "md-" + metadata.toc[index].ID
	}
	return metadata, nil
}

type githubHeadingIDTransformer struct{}

func (*githubHeadingIDTransformer) Transform(document *ast.Document, reader text.Reader, _ parser.Context) {
	used := make(map[string]struct{})
	var visit func(ast.Node)
	visit = func(node ast.Node) {
		if heading, ok := node.(*ast.Heading); ok {
			base := githubHeadingSlug(string(heading.Text(reader.Source())))
			id := base
			for suffix := 1; ; suffix++ {
				if _, exists := used[id]; !exists {
					break
				}
				id = base + "-" + strconv.Itoa(suffix)
			}
			used[id] = struct{}{}
			heading.SetAttributeString("id", id)
		}
		for child := node.FirstChild(); child != nil; child = child.NextSibling() {
			visit(child)
		}
	}
	visit(document)
}

func githubHeadingSlug(value string) string {
	var slug strings.Builder
	for _, character := range strings.ToLower(value) {
		switch {
		case character == ' ':
			slug.WriteByte('-')
		case character == '-' || character == '_' || unicode.IsLetter(character) || unicode.IsNumber(character) || unicode.IsMark(character):
			slug.WriteRune(character)
		}
	}
	return slug.String()
}

func readArtifactHTMLDocument(source io.Reader) (artifactHTMLMetadata, error) {
	document, err := html.Parse(source)
	if err != nil {
		return artifactHTMLMetadata{}, err
	}
	metadata := artifactHTMLMetadata{toc: make([]TOCEntry, 0)}
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if node.Type == html.ElementNode && node.Data == "title" && metadata.title == "" {
			metadata.title = normalizedText(node)
		}
		if node.Type == html.ElementNode && len(node.Data) == 2 && node.Data[0] == 'h' && node.Data[1] >= '1' && node.Data[1] <= '3' {
			id := ""
			for _, attribute := range node.Attr {
				if attribute.Key == "id" {
					id = strings.TrimSpace(attribute.Val)
					break
				}
			}
			text := normalizedText(node)
			if node.Data == "h1" && metadata.firstH1 == "" {
				metadata.firstH1 = text
			}
			if id != "" && text != "" {
				metadata.toc = append(metadata.toc, TOCEntry{Level: int(node.Data[1] - '0'), Text: text, ID: id})
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(document)
	return metadata, nil
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
	output, err := exec.CommandContext(ctx, "git", "log", "-z", "--format=%ct%x1f%cn", "--name-only", "--no-renames", "--", filepath.FromSlash(pathspec)).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("read Git history for source directory: %w: %s", err, strings.TrimSpace(string(output)))
	}

	latestByArtifact := make(map[string]artifactGitUpdate, len(artifacts))
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
		for _, artifactPath := range artifactPathsForFile(relativeFile, artifactDirectories, artifactFiles) {
			update := latestByArtifact[artifactPath]
			if currentCommitTime.After(update.updatedAt) {
				update.updatedAt = currentCommitTime
				update.lastCommitter = currentCommitter
				latestByArtifact[artifactPath] = update
			}
		}
	}
	return latestByArtifact, nil
}

func artifactWorkingTreeUpdates(ctx context.Context, repositoryRoot, sourcePath string, artifacts []discoveredArtifact, deletedAt time.Time) (map[string]time.Time, error) {
	artifactDirectories, artifactFiles := artifactPathLookup(artifacts)

	output, err := exec.CommandContext(ctx, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", filepath.FromSlash(sourcePath)).CombinedOutput()
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
		if len(word) > 0 {
			words[index] = strings.ToUpper(word[:1]) + word[1:]
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
