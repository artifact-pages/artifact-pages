package indexer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const buildInputPolicyVersion = 2

// SourceFileSnapshot is one regular source file captured by PrepareBuild.
// Bytes are the exact immutable bytes used by both index construction and
// publisher uploads. ModTime is retained for the existing fallback timestamp
// contract but is not itself part of the fingerprint unless it affects an
// emitted document timestamp.
type SourceFileSnapshot struct {
	RelativePath string
	SHA256       string
	Size         int64
	ModTime      time.Time
	bytes        []byte
}

type preparedDocument struct {
	artifact      discoveredArtifact
	updatedAt     time.Time
	lastCommitter string
}

// PreparedBuild is an immutable local snapshot with all Git-derived metadata
// resolved before the expensive HTML/Markdown and full-text projection build.
// Callers may compare InputRoot with a previous publish state and skip Build
// when Reusable is true.
type PreparedBuild struct {
	inputRoot string
	reusable  bool
	files     []SourceFileSnapshot

	options        BuildOptions
	outputRoot     string
	repositoryRoot string
	relativeSource string
	gitInfo        gitMetadata
	documents      []preparedDocument
	fileByRelative map[string]SourceFileSnapshot
	scannedFiles   int
	indexTime      time.Time
}

// InputRoot is a stable hash of all inputs that affect the generated
// projection, excluding the transaction-time generatedAt field.
func (prepared *PreparedBuild) InputRoot() string { return prepared.inputRoot }

// Reusable reports whether the resolved metadata can be safely reused on a
// matching input root. It is false when Build's current contract uses the
// invocation clock for an absent tracked dependency.
func (prepared *PreparedBuild) Reusable() bool { return prepared.reusable }

// SourceFiles returns a copy of the snapshot's public file metadata. Bytes
// remain private so callers cannot mutate content after its fingerprint was
// computed.
func (prepared *PreparedBuild) SourceFiles() []SourceFileSnapshot {
	files := make([]SourceFileSnapshot, len(prepared.files))
	copy(files, prepared.files)
	for index := range files {
		files[index].bytes = nil
	}
	return files
}

// ReadSourceFile returns a copy of one captured file's exact bytes.
func (prepared *PreparedBuild) ReadSourceFile(relativePath string) ([]byte, bool) {
	file, exists := prepared.fileByRelative[relativePath]
	if !exists {
		return nil, false
	}
	return append([]byte(nil), file.bytes...), true
}

type inputFingerprint struct {
	Domain        string                `json:"domain"`
	Policy        int                   `json:"policy"`
	Publisher     string                `json:"publisherPolicy,omitempty"`
	SiteID        string                `json:"siteId"`
	Title         string                `json:"title"`
	Description   string                `json:"description"`
	FullText      bool                  `json:"fullText"`
	SourcePath    string                `json:"sourcePath"`
	Repository    string                `json:"repository"`
	RepositoryURL string                `json:"repositoryUrl"`
	Ref           string                `json:"ref"`
	Files         []fingerprintFile     `json:"files"`
	Documents     []fingerprintDocument `json:"documents"`
}

type fingerprintFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type fingerprintDocument struct {
	Path          string `json:"path"`
	UpdatedAt     string `json:"updatedAt"`
	LastCommitter string `json:"lastCommitter,omitempty"`
}

type sourceFileReader func(string) ([]byte, error)
type sourceFileOpener func(string) (*os.File, error)

type sourceCaptureMode struct {
	indexOnly bool
	readFile  sourceFileReader
	openFile  sourceFileOpener
}

// PrepareBuild snapshots every regular file once, resolves the same Git and
// filesystem timestamps used by Build, and computes a deterministic root
// before parsing documents or constructing full-text search data.
func PrepareBuild(ctx context.Context, options BuildOptions) (*PreparedBuild, error) {
	return prepareBuild(ctx, options, sourceCaptureMode{})
}

// prepareBuild is shared by the public full-snapshot API and standalone index
// builds. The latter captures document bytes and all source metadata, but skips
// resource bodies and the publisher input fingerprint.
func prepareBuild(ctx context.Context, options BuildOptions, captureMode sourceCaptureMode) (*PreparedBuild, error) {
	if !siteIDPattern.MatchString(options.SiteID) {
		return nil, fmt.Errorf("invalid site identifier %q: use lowercase letters, numbers, and internal hyphens", options.SiteID)
	}
	if options.SourceDir == "" {
		return nil, errors.New("source directory is required")
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
		return nil, fmt.Errorf("get current directory: %w", err)
	}
	repositoryRoot, err := gitOutput(ctx, workingDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, fmt.Errorf("index builds must run inside a Git working tree: %w", err)
	}
	repositoryRoot, err = filepath.EvalSymlinks(strings.TrimSpace(repositoryRoot))
	if err != nil {
		return nil, fmt.Errorf("resolve Git working tree: %w", err)
	}
	sourcePath := options.SourceDir
	if !filepath.IsAbs(sourcePath) {
		sourcePath = filepath.Join(workingDir, sourcePath)
	}
	sourcePath, err = filepath.Abs(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("resolve source directory: %w", err)
	}
	sourcePath, err = filepath.EvalSymlinks(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("resolve source directory %q: %w", options.SourceDir, err)
	}
	if err := ensureWithin(repositoryRoot, sourcePath); err != nil {
		return nil, fmt.Errorf("source directory must be inside the Git working tree: %w", err)
	}
	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return nil, fmt.Errorf("read source directory: %w", err)
	}
	if !sourceInfo.IsDir() {
		return nil, fmt.Errorf("source path %q is not a directory", options.SourceDir)
	}
	outputRoot := options.OutputDir
	if !filepath.IsAbs(outputRoot) {
		outputRoot = filepath.Join(workingDir, outputRoot)
	}
	outputRoot, err = filepath.Abs(outputRoot)
	if err != nil {
		return nil, fmt.Errorf("resolve output directory: %w", err)
	}
	if filepath.Clean(outputRoot) == filepath.Clean(sourcePath) {
		return nil, errors.New("output directory cannot be the artifact source directory")
	}

	files, artifacts, scannedFiles, latestByDirectory, err := captureSourceTree(sourcePath, outputRoot, options.RejectSymlinks, captureMode)
	if err != nil {
		return nil, err
	}
	relativeSource, err := filepath.Rel(repositoryRoot, sourcePath)
	if err != nil {
		return nil, fmt.Errorf("resolve source path relative to Git working tree: %w", err)
	}
	relativeSource = filepath.ToSlash(relativeSource)
	if err := ValidateUTF8RelativePath(relativeSource); err != nil {
		return nil, fmt.Errorf("source path %w", err)
	}
	gitUpdates, err := artifactGitUpdates(ctx, repositoryRoot, relativeSource, artifacts)
	if err != nil {
		return nil, err
	}
	workingTreeUpdates, clockDependent, err := artifactWorkingTreeUpdatesFromSnapshot(ctx, repositoryRoot, relativeSource, artifacts, files, indexTime)
	if err != nil {
		return nil, err
	}
	gitInfo := resolveGitMetadata(ctx, repositoryRoot, options)
	title := strings.TrimSpace(options.SiteTitle)
	if title == "" {
		title = humanize(path.Base(options.SiteID))
	}
	description := options.SiteDescription
	if strings.TrimSpace(description) == "" {
		description = ""
	}
	options.SiteTitle = title
	options.SiteDescription = description
	options.SourceDir = sourcePath
	options.OutputDir = outputRoot
	prepared := &PreparedBuild{
		reusable:       len(clockDependent) == 0,
		files:          files,
		fileByRelative: make(map[string]SourceFileSnapshot, len(files)),
		options:        options,
		outputRoot:     outputRoot,
		repositoryRoot: repositoryRoot,
		relativeSource: relativeSource,
		gitInfo:        gitInfo,
		scannedFiles:   scannedFiles,
		indexTime:      indexTime,
	}
	for _, file := range files {
		if captureMode.indexOnly && !isDocumentPath(file.RelativePath) {
			continue
		}
		prepared.fileByRelative[file.RelativePath] = file
	}
	for _, artifact := range artifacts {
		gitUpdate := gitUpdates[artifact.relative]
		updatedAt, found := gitUpdate.updatedAt, !gitUpdate.updatedAt.IsZero()
		if workingTreeTime, hasWorkingTreeUpdate := workingTreeUpdates[artifact.relative]; hasWorkingTreeUpdate && (!found || workingTreeTime.After(updatedAt)) {
			updatedAt = workingTreeTime
			found = true
		}
		if !found {
			var exists bool
			updatedAt, exists = latestByDirectory[artifact.directoryRelative]
			if !exists || updatedAt.IsZero() {
				return nil, fmt.Errorf("read modification time for artifact %q: artifact directory contains no files", artifact.relative)
			}
		}
		prepared.documents = append(prepared.documents, preparedDocument{artifact: artifact, updatedAt: updatedAt, lastCommitter: gitUpdate.lastCommitter})
	}
	if !captureMode.indexOnly {
		prepared.inputRoot, err = fingerprintPreparedBuild(prepared)
		if err != nil {
			return nil, fmt.Errorf("fingerprint site build inputs: %w", err)
		}
	}
	return prepared, nil
}

func captureSourceTree(sourcePath, outputRoot string, rejectSymlinks bool, captureMode sourceCaptureMode) ([]SourceFileSnapshot, []discoveredArtifact, int, map[string]time.Time, error) {
	var files []SourceFileSnapshot
	var artifacts []discoveredArtifact
	latestByDirectory := make(map[string]time.Time)
	scannedFiles := 0
	readFile := captureMode.readFile
	if readFile == nil {
		readFile = os.ReadFile
	}
	openFile := captureMode.openFile
	if openFile == nil {
		openFile = os.Open
	}
	err := filepath.WalkDir(sourcePath, func(currentPath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if currentPath != sourcePath && entry.Name() == ".git" {
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("site source must not contain symbolic links: %s", currentPath)
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if info.IsDir() {
				return filepath.SkipDir
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("unsupported filesystem entry in site source: %s", currentPath)
			}
			return nil
		}
		if currentPath != sourcePath && entry.IsDir() && pathWithin(outputRoot, currentPath) {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		scannedFiles++
		isSymlink := entry.Type()&os.ModeSymlink != 0
		if isSymlink && rejectSymlinks {
			return fmt.Errorf("site source must not contain symbolic links: %s", currentPath)
		}
		if isSymlink && (isHTMLDocument(entry.Name()) || isMarkdownDocument(entry.Name())) {
			return fmt.Errorf("artifact entrypoint %q must not be a symlink", currentPath)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !isSymlink && !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported filesystem entry in site source: %s", currentPath)
		}
		isDocument := isDocumentPath(entry.Name())
		relative, err := filepath.Rel(sourcePath, currentPath)
		if err != nil {
			return fmt.Errorf("resolve site path %q: %w", currentPath, err)
		}
		relative = filepath.ToSlash(relative)
		if err := ValidateUTF8RelativePath(relative); err != nil {
			return fmt.Errorf("site source %w", err)
		}
		var symlinkTargetInfo fs.FileInfo
		if isSymlink && !isDocument {
			symlinkTargetInfo, err = os.Stat(currentPath)
			if err != nil {
				return fmt.Errorf("read source file %s: %w", relative, err)
			}
			if !symlinkTargetInfo.Mode().IsRegular() {
				return fmt.Errorf("unsupported filesystem entry in site source: %s", currentPath)
			}
		}
		if captureMode.indexOnly && !isDocument {
			readableInfo := info
			if isSymlink {
				readableInfo = symlinkTargetInfo
			}
			if err := verifyResourceReadable(currentPath, relative, readableInfo, openFile); err != nil {
				return err
			}
		}
		var data []byte
		captureBytes := !captureMode.indexOnly || isDocument
		if captureBytes {
			data, err = readFile(currentPath)
			if err != nil {
				return fmt.Errorf("read source file %s: %w", relative, err)
			}
		}
		afterInfo, err := os.Lstat(currentPath)
		if err != nil {
			return fmt.Errorf("verify source file %s after read: %w", relative, err)
		}
		if afterInfo.Size() != info.Size() || !afterInfo.ModTime().Equal(info.ModTime()) || afterInfo.Mode().Type() != info.Mode().Type() || (captureBytes && !isSymlink && int64(len(data)) != afterInfo.Size()) {
			return errors.New("site source changed while preparing publish; retry with a stable working tree")
		}
		if isSymlink && !isDocument {
			afterTargetInfo, statErr := os.Stat(currentPath)
			if statErr != nil {
				return fmt.Errorf("read source file %s: %w", relative, statErr)
			}
			if !afterTargetInfo.Mode().IsRegular() {
				return fmt.Errorf("unsupported filesystem entry in site source: %s", currentPath)
			}
			if afterTargetInfo.Size() != symlinkTargetInfo.Size() || !afterTargetInfo.ModTime().Equal(symlinkTargetInfo.ModTime()) || afterTargetInfo.Mode().Type() != symlinkTargetInfo.Mode().Type() {
				return errors.New("site source changed while preparing publish; retry with a stable working tree")
			}
		}
		fileSize := info.Size()
		if isSymlink && !isDocument {
			fileSize = symlinkTargetInfo.Size()
		}
		if captureBytes {
			fileSize = int64(len(data))
		}
		digestHex := ""
		if !captureMode.indexOnly {
			digest := sha256.Sum256(data)
			digestHex = hex.EncodeToString(digest[:])
		}
		file := SourceFileSnapshot{
			RelativePath: relative,
			SHA256:       digestHex,
			Size:         fileSize,
			ModTime:      info.ModTime(),
			bytes:        data,
		}
		files = append(files, file)
		directory := path.Dir(relative)
		if file.ModTime.After(latestByDirectory[directory]) {
			latestByDirectory[directory] = file.ModTime
		}
		if isDocument {
			fileRelative := relative
			artifacts = append(artifacts, discoveredArtifact{
				directory:         filepath.Join(sourcePath, filepath.FromSlash(directory)),
				directoryRelative: directory,
				relative:          relative,
				file:              currentPath,
				fileRelative:      fileRelative,
				filename:          entry.Name(),
			})
		}
		return nil
	})
	if err != nil {
		return nil, nil, scannedFiles, nil, fmt.Errorf("inspect site source: %w", err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].RelativePath < files[j].RelativePath })
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].relative < artifacts[j].relative })
	// latestArtifactFileModTime recurses through nested resources. Expand each
	// document directory's latest timestamp from every descendant source file.
	for _, file := range files {
		directory := path.Dir(file.RelativePath)
		for directory != "." && directory != "/" {
			if file.ModTime.After(latestByDirectory[directory]) {
				latestByDirectory[directory] = file.ModTime
			}
			directory = path.Dir(directory)
		}
		if file.ModTime.After(latestByDirectory["."]) {
			latestByDirectory["."] = file.ModTime
		}
	}
	return files, artifacts, scannedFiles, latestByDirectory, nil
}

func isDocumentPath(name string) bool {
	name = path.Base(filepath.ToSlash(name))
	return isHTMLDocument(name) || isMarkdownDocument(name)
}

func verifyResourceReadable(filename, relative string, expected fs.FileInfo, openFile sourceFileOpener) error {
	file, err := openFile(filename)
	if err != nil {
		return fmt.Errorf("read source file %s: %w", relative, err)
	}
	openedInfo, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil {
		return fmt.Errorf("stat source file %s: %w", relative, statErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close source file %s: %w", relative, closeErr)
	}
	if !openedInfo.Mode().IsRegular() {
		return fmt.Errorf("unsupported filesystem entry in site source: %s", filename)
	}
	if openedInfo.Size() != expected.Size() || !openedInfo.ModTime().Equal(expected.ModTime()) || openedInfo.Mode().Type() != expected.Mode().Type() {
		return errors.New("site source changed while preparing publish; retry with a stable working tree")
	}
	return nil
}

func artifactWorkingTreeUpdatesFromSnapshot(ctx context.Context, repositoryRoot, sourcePath string, artifacts []discoveredArtifact, files []SourceFileSnapshot, deletedAt time.Time) (map[string]time.Time, map[string]struct{}, error) {
	artifactDirectories, artifactFiles := artifactPathLookup(artifacts)
	pathspec := sourcePath
	if pathspec == "" {
		pathspec = "."
	}
	command := exec.CommandContext(ctx, "git", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", filepath.FromSlash(pathspec))
	command.Dir = repositoryRoot
	output, err := command.CombinedOutput()
	if err != nil {
		return nil, nil, fmt.Errorf("read Git working-tree changes for source directory: %w: %s", err, strings.TrimSpace(string(output)))
	}
	latestByArtifact := make(map[string]time.Time)
	clockDependent := make(map[string]struct{})
	filesByRelative := make(map[string]SourceFileSnapshot, len(files))
	for _, file := range files {
		filesByRelative[file.RelativePath] = file
	}
	for _, part := range strings.Split(string(output), "\x00") {
		record := part
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
		if sourceFile, exists := filesByRelative[file]; exists {
			updatedAt = sourceFile.ModTime
		} else {
			for _, artifactPath := range artifactPaths {
				clockDependent[artifactPath] = struct{}{}
			}
		}
		for _, artifactPath := range artifactPaths {
			if updatedAt.After(latestByArtifact[artifactPath]) {
				latestByArtifact[artifactPath] = updatedAt
			}
		}
	}
	return latestByArtifact, clockDependent, nil
}

func fingerprintPreparedBuild(prepared *PreparedBuild) (string, error) {
	fingerprint := inputFingerprint{
		Domain: "artifact-pages-site-input-v2", Policy: buildInputPolicyVersion,
		Publisher: prepared.options.InputPolicy, SiteID: prepared.options.SiteID,
		Title: prepared.options.SiteTitle, Description: prepared.options.SiteDescription,
		FullText: true, SourcePath: prepared.relativeSource,
		Repository: prepared.gitInfo.repository, RepositoryURL: prepared.gitInfo.repositoryURL, Ref: prepared.gitInfo.ref,
		Files:     make([]fingerprintFile, 0, len(prepared.files)),
		Documents: make([]fingerprintDocument, 0, len(prepared.documents)),
	}
	for _, file := range prepared.files {
		fingerprint.Files = append(fingerprint.Files, fingerprintFile{Path: file.RelativePath, SHA256: file.SHA256, Size: file.Size})
	}
	for _, document := range prepared.documents {
		fingerprint.Documents = append(fingerprint.Documents, fingerprintDocument{
			Path: document.artifact.relative, UpdatedAt: document.updatedAt.UTC().Format(time.RFC3339),
			LastCommitter: document.lastCommitter,
		})
	}
	encoded, err := json.Marshal(fingerprint)
	if err != nil {
		return "", err
	}
	encoded = append([]byte("artifact-pages-site-input-v1\x00"), encoded...)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}
