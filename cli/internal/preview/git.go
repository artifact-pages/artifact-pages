package preview

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/artifact-pages/artifact-pages/cli/internal/gitdepth"
	"net/url"
	"os/exec"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/artifact-pages/artifact-pages/cli/internal/githubrepo"
)

type Outcome string

const (
	OutcomePublished Outcome = "published"
	OutcomeNoPreview Outcome = "no-preview"
)

var (
	ErrImmutableRevisionMismatch = errors.New("the same preview head already has a different immutable projection")
)

type BuildOptions struct {
	RepositoryDir             string
	SiteID                    string
	SourcePath                string
	DefaultRef                string
	HeadRef                   string
	Repository                string
	PullRequestURL            string
	PullRequestHeadRepository string
	PullRequestHeadSHA        string
	ExplicitResources         []string
	Now                       func() time.Time
}

type BuildResult struct {
	Site     string
	Outcome  Outcome
	Group    Group
	Manifest RevisionManifest
	Files    map[string][]byte
}

type treeEntry struct {
	Mode string
	Type string
	SHA  string
	Path string
}

type diffEntry struct {
	Status   string
	OldPath  string
	NewPath  string
	Path     string
	Document bool
}

type blobReuseStats struct {
	MaxReusableCacheBytes           int64
	CacheBytesAtAssemblyStart       int64
	CacheBytesAfterAssembly         int64
	GitBodyBytesAvoided             int64
	SelectedFileBytes               int64
	MaxExplicitBlobBufferBytes      int64
	selectedFileBytesDuringAssembly int64
}

// buildBlobReuse is scoped to one BuildFromGit call. Its bodies are exact Git
// blobs keyed by Git's content SHA; it is never retained across builds.
type buildBlobReuse struct {
	bodies map[string][]byte
	stats  *blobReuseStats
}

func (reuse *buildBlobReuse) bodyBytes() int64 {
	if reuse == nil {
		return 0
	}
	var total int64
	for _, body := range reuse.bodies {
		total += int64(len(body))
	}
	return total
}

func (reuse *buildBlobReuse) observeCacheAndScratch(scratch map[string][]byte) {
	if reuse == nil || reuse.stats == nil {
		return
	}
	cacheBytes := reuse.bodyBytes()
	scratchBytes := int64(0)
	for _, body := range scratch {
		scratchBytes += int64(len(body))
	}
	if cacheBytes > reuse.stats.MaxReusableCacheBytes {
		reuse.stats.MaxReusableCacheBytes = cacheBytes
	}
	if current := cacheBytes + scratchBytes; current > reuse.stats.MaxExplicitBlobBufferBytes {
		reuse.stats.MaxExplicitBlobBufferBytes = current
	}
}

func (reuse *buildBlobReuse) retainScratch(scratch map[string][]byte) {
	if reuse == nil {
		return
	}
	for sha, body := range scratch {
		if _, alreadyRetained := reuse.bodies[sha]; !alreadyRetained {
			reuse.bodies[sha] = body
		}
	}
	reuse.observeCacheAndScratch(nil)
}

func (reuse *buildBlobReuse) readForBundle(ctx context.Context, repoRoot string, entry treeEntry, selectedBySHA map[string][]byte) ([]byte, error) {
	if err := validateTreeBlobEntry(entry); err != nil {
		return nil, err
	}
	var body []byte
	if selectedBySHA != nil {
		if previous, ok := selectedBySHA[entry.SHA]; ok {
			body = bytes.Clone(previous)
			if reuse != nil && reuse.stats != nil {
				reuse.stats.GitBodyBytesAvoided += int64(len(body))
			}
		} else if cached, ok := reuse.bodies[entry.SHA]; ok {
			body = cached
			delete(reuse.bodies, entry.SHA)
			selectedBySHA[entry.SHA] = body
			if reuse.stats != nil {
				reuse.stats.GitBodyBytesAvoided += int64(len(body))
			}
		} else {
			var err error
			body, err = readTreeBlob(ctx, repoRoot, entry)
			if err != nil {
				return nil, err
			}
			selectedBySHA[entry.SHA] = body
		}
	} else {
		var err error
		body, err = readTreeBlob(ctx, repoRoot, entry)
		if err != nil {
			return nil, err
		}
	}
	if reuse != nil && reuse.stats != nil {
		reuse.stats.selectedFileBytesDuringAssembly += int64(len(body))
		if current := reuse.bodyBytes() + reuse.stats.selectedFileBytesDuringAssembly; current > reuse.stats.MaxExplicitBlobBufferBytes {
			reuse.stats.MaxExplicitBlobBufferBytes = current
		}
	}
	return body, nil
}

func readTreeBlobForBundle(ctx context.Context, repoRoot string, entry treeEntry, reuse *buildBlobReuse, selectedBySHA map[string][]byte) ([]byte, error) {
	if reuse != nil {
		return reuse.readForBundle(ctx, repoRoot, entry, selectedBySHA)
	}
	return readTreeBlob(ctx, repoRoot, entry)
}

func BuildFromGit(ctx context.Context, options BuildOptions) (BuildResult, error) {
	return buildFromGit(ctx, options, true, nil)
}

// buildFromGit keeps the prior read path available to the tagged cost probe;
// normal callers always use the per-build same-blob reuse path.
func buildFromGit(ctx context.Context, options BuildOptions, reuseBlobBodies bool, stats *blobReuseStats) (BuildResult, error) {
	if !validSiteID(options.SiteID) {
		return BuildResult{}, fmt.Errorf("invalid preview site identifier %q", options.SiteID)
	}
	sourcePath, err := canonicalSourcePath(options.SourcePath)
	if err != nil {
		return BuildResult{}, err
	}
	if strings.TrimSpace(options.DefaultRef) == "" || strings.TrimSpace(options.HeadRef) == "" {
		return BuildResult{}, errors.New("default ref and source head ref are required")
	}
	repoDir := options.RepositoryDir
	if repoDir == "" {
		repoDir = "."
	}
	repoRootOutput, err := gitOutput(ctx, repoDir, "rev-parse", "--show-toplevel")
	if err != nil {
		return BuildResult{}, fmt.Errorf("preview selection must run inside a Git working tree: %w", err)
	}
	repoRoot := strings.TrimSpace(string(repoRootOutput))
	defaultHead, err := resolveCommit(ctx, repoRoot, options.DefaultRef)
	if err != nil {
		if fetchErr := fetchMissingDefaultRef(ctx, repoRoot, options.DefaultRef); fetchErr == nil {
			defaultHead, err = resolveCommit(ctx, repoRoot, options.DefaultRef)
		}
	}
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve default-branch HEAD: %w", err)
	}
	head, err := resolveCommit(ctx, repoRoot, options.HeadRef)
	if err != nil && shaPattern.MatchString(options.HeadRef) {
		if fetchErr := fetchMissingCommit(ctx, repoRoot, options.HeadRef); fetchErr == nil {
			head, err = resolveCommit(ctx, repoRoot, options.HeadRef)
		}
	}
	if err != nil {
		return BuildResult{}, fmt.Errorf("resolve preview source head: %w", err)
	}
	groupID, groupKind, prURL, err := groupIdentity(options, head)
	if err != nil {
		return BuildResult{}, err
	}
	updatedAt := time.Now().UTC()
	if options.Now != nil {
		updatedAt = options.Now().UTC()
	}
	updatedAtText := updatedAt.Format(time.RFC3339)
	group := Group{ID: groupID, Kind: groupKind, HeadSHA: head, PRURL: prURL, UpdatedAt: updatedAtText, Documents: []Document{}}
	mergeBase, err := gitdepth.EnsureMergeBase(ctx, repoRoot, defaultHead, head)
	if err != nil {
		return BuildResult{}, fmt.Errorf("find comparison merge-base: %w", err)
	}
	if !shaPattern.MatchString(mergeBase) {
		return BuildResult{}, fmt.Errorf("git returned an invalid merge-base %q", mergeBase)
	}
	changesBytes, err := gitOutput(ctx, repoRoot, "diff", "--no-ext-diff", "--name-status", "-z", "--find-renames", mergeBase, head, "--", sourcePathspec(sourcePath))
	if err != nil {
		return BuildResult{}, fmt.Errorf("compare merge-base and source head: %w", err)
	}
	changes, err := parseNameStatus(changesBytes)
	if err != nil {
		return BuildResult{}, err
	}
	changes, err = makeChangesSourceRelative(changes, sourcePath)
	if err != nil {
		return BuildResult{}, err
	}
	if len(changes) == 0 {
		return BuildResult{Site: options.SiteID, Outcome: OutcomeNoPreview, Group: group}, nil
	}

	selected := make([]string, 0)
	changedResources := make([]string, 0)
	deletedResources := make(map[string]bool)
	for _, change := range changes {
		if change.Status == "D" && isDocumentPath(change.Path) {
			continue
		}
		if change.Status == "D" {
			deletedResources[change.Path] = true
			continue
		}
		if change.Status == "R" && change.OldPath != "" && !isDocumentPath(change.OldPath) {
			deletedResources[change.OldPath] = true
		}
		if change.NewPath == "" {
			continue
		}
		if isDocumentPath(change.NewPath) {
			if change.Status == "A" || change.Status == "M" || change.Status == "R" || change.Status == "C" || change.Status == "T" {
				selected = append(selected, change.NewPath)
			}
			continue
		}
		changedResources = append(changedResources, change.NewPath)
	}
	sort.Strings(selected)
	selected = uniqueStrings(selected)
	sort.Strings(changedResources)
	changedResources = uniqueStrings(changedResources)

	tree, err := listTree(ctx, repoRoot, head, sourcePath)
	if err != nil {
		return BuildResult{}, err
	}
	reasons := make(map[string]Document, len(selected))
	for _, relativePath := range selected {
		reasons[relativePath] = Document{Reason: ReasonChanged}
	}
	var reusableBlobs *buildBlobReuse
	if reuseBlobBodies {
		reusableBlobs = &buildBlobReuse{bodies: make(map[string][]byte), stats: stats}
	}
	if len(changedResources) > 0 || len(deletedResources) > 0 {
		affected, err := findDependencyDocuments(ctx, repoRoot, tree, changedResources, deletedResources, reasons, reusableBlobs)
		if err != nil {
			return BuildResult{}, err
		}
		for relativePath, resources := range affected {
			reasons[relativePath] = Document{Reason: ReasonDependency, ChangedResources: resources}
			selected = append(selected, relativePath)
		}
		sort.Strings(selected)
	}
	if len(selected) == 0 {
		return BuildResult{Site: options.SiteID, Outcome: OutcomeNoPreview, Group: group}, nil
	}

	files := make(map[string][]byte)
	var selectedBySHA map[string][]byte
	if reusableBlobs != nil {
		selectedBySHA = make(map[string][]byte)
		if stats != nil {
			stats.CacheBytesAtAssemblyStart = reusableBlobs.bodyBytes()
		}
	}
	documents := make([]Document, 0, len(selected))
	queue := make([]string, 0)
	for _, relativePath := range selected {
		if err := validateDocumentPath(relativePath); err != nil {
			return BuildResult{}, err
		}
		entry, ok := tree[relativePath]
		if !ok {
			return BuildResult{}, fmt.Errorf("changed document %q is missing from the source head tree", relativePath)
		}
		content, err := readTreeBlobForBundle(ctx, repoRoot, entry, reusableBlobs, selectedBySHA)
		if err != nil {
			return BuildResult{}, err
		}
		files[relativePath] = content
		queue = append(queue, relativePath)
		document := extractDocument(relativePath, content)
		document.Reason = reasons[relativePath].Reason
		document.ChangedResources = reasons[relativePath].ChangedResources
		documents = append(documents, document)
	}

	explicitResources, err := expandResourcePatterns(tree, options.ExplicitResources)
	if err != nil {
		return BuildResult{}, err
	}
	queue = append(queue, explicitResources...)
	if err := collectResources(ctx, repoRoot, tree, files, queue, reusableBlobs, selectedBySHA); err != nil {
		return BuildResult{}, err
	}
	if stats != nil {
		stats.SelectedFileBytes = sumFileBytes(files)
		if reusableBlobs != nil {
			stats.CacheBytesAfterAssembly = reusableBlobs.bodyBytes()
		}
	}

	sortDocuments(documents)
	manifest := RevisionManifest{
		SchemaVersion: SchemaVersion,
		Site:          options.SiteID,
		HeadSHA:       head,
		DefaultHead:   defaultHead,
		MergeBase:     mergeBase,
		CreatedAt:     updatedAtText,
		BundleDigest:  digestBundle(files),
		Files:         describeFiles(files),
		Documents:     documents,
	}
	if err := ValidateManifest(manifest); err != nil {
		return BuildResult{}, err
	}
	group.Documents = append([]Document(nil), documents...)
	if err := ValidateCatalog(Catalog{SchemaVersion: SchemaVersion, Site: options.SiteID, Groups: []Group{group}}); err != nil {
		return BuildResult{}, err
	}
	return BuildResult{Site: options.SiteID, Outcome: OutcomePublished, Group: group, Manifest: manifest, Files: files}, nil
}

func expandResourcePatterns(tree map[string]treeEntry, patterns []string) ([]string, error) {
	selected := make(map[string]struct{})
	for _, pattern := range patterns {
		if err := validateSourcePath(pattern); err != nil {
			return nil, fmt.Errorf("explicit preview resource %q: %w", pattern, err)
		}
		isPattern := strings.ContainsAny(pattern, "*?[")
		if _, err := path.Match(pattern, ""); err != nil {
			return nil, fmt.Errorf("explicit preview resource pattern %q: %w", pattern, err)
		}
		matches := make([]string, 0)
		for candidate := range tree {
			matched, err := path.Match(pattern, candidate)
			if err != nil {
				return nil, fmt.Errorf("explicit preview resource pattern %q: %w", pattern, err)
			}
			if matched {
				matches = append(matches, candidate)
			}
		}
		if len(matches) == 0 {
			return nil, fmt.Errorf("explicit preview resource %q did not match a file in the source head tree", pattern)
		}
		sort.Strings(matches)
		for _, match := range matches {
			if isDocumentPath(match) {
				if isPattern {
					return nil, fmt.Errorf("explicit preview resource pattern %q matched document %q; unchanged documents cannot be included as resources", pattern, match)
				}
				return nil, fmt.Errorf("explicit preview resource %q is a document; unchanged documents cannot be included as resources", pattern)
			}
			selected[match] = struct{}{}
		}
	}
	paths := make([]string, 0, len(selected))
	for resource := range selected {
		paths = append(paths, resource)
	}
	sort.Strings(paths)
	return paths, nil
}

func groupIdentity(options BuildOptions, headSHA string) (id, kind, prURL string, err error) {
	if options.PullRequestURL == "" {
		id, err = GroupIDForHead(headSHA)
		return id, "manual", "", err
	}
	parsed, parseErr := url.Parse(options.PullRequestURL)
	if parseErr != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil || strings.ContainsAny(options.PullRequestURL, "?#") {
		return "", "", "", fmt.Errorf("pull request URL %q must be a canonical GitHub pull URL", options.PullRequestURL)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || parts[0] == "" || parts[1] == "" || parts[2] != "pull" {
		return "", "", "", fmt.Errorf("pull request URL %q must use https://github.com/<owner>/<repo>/pull/<number>", options.PullRequestURL)
	}
	var number int
	if _, scanErr := fmt.Sscanf(parts[3], "%d", &number); scanErr != nil || number < 1 || fmt.Sprint(number) != parts[3] {
		return "", "", "", fmt.Errorf("pull request URL %q has an invalid number", options.PullRequestURL)
	}
	if options.Repository == "" || options.PullRequestHeadRepository == "" {
		return "", "", "", errors.New("PR previews require the registered source repository and PR head repository")
	}
	if !shaPattern.MatchString(options.PullRequestHeadSHA) || options.PullRequestHeadSHA != headSHA {
		return "", "", "", fmt.Errorf("pull request head SHA must match the selected preview head %s", headSHA)
	}
	registeredRepository, repositoryErr := normalizeRepository(options.Repository)
	if repositoryErr != nil {
		return "", "", "", repositoryErr
	}
	prHeadRepository, headRepositoryErr := normalizeRepository(options.PullRequestHeadRepository)
	if headRepositoryErr != nil {
		return "", "", "", headRepositoryErr
	}
	if !strings.EqualFold(registeredRepository, parts[0]+"/"+parts[1]) || !strings.EqualFold(prHeadRepository, registeredRepository) {
		return "", "", "", fmt.Errorf("pull request %q must target and originate from registered repository %q", options.PullRequestURL, options.Repository)
	}
	if parsed.EscapedPath() != "/"+strings.Join(parts, "/") {
		return "", "", "", fmt.Errorf("pull request URL %q is not canonical", options.PullRequestURL)
	}
	id, err = GroupIDForPR(number)
	if err != nil {
		return "", "", "", err
	}
	return id, "pull-request", options.PullRequestURL, nil
}

func canonicalSourcePath(value string) (string, error) {
	if value == "" {
		return "", errors.New("registered source path is required")
	}
	if value == "." {
		return value, nil
	}
	if !utf8.ValidString(value) || strings.TrimSpace(value) != value || strings.Contains(value, `\`) || path.IsAbs(value) || path.Clean(value) != value || strings.HasPrefix(value, "../") || value == ".." {
		return "", fmt.Errorf("source path %q must be a canonical repository-relative POSIX path", value)
	}
	return value, nil
}

func sourcePathspec(sourcePath string) string {
	if sourcePath == "." {
		return "."
	}
	return ":(literal)" + sourcePath
}

// fetchMissingDefaultRef fetches an `origin/NAME` default ref that a shallow
// checkout does not contain. It does nothing in a complete checkout, where a
// missing ref is a configuration error the caller should see.
func fetchMissingDefaultRef(ctx context.Context, repoRoot, ref string) error {
	shallow, err := gitdepth.IsShallow(ctx, repoRoot)
	if err != nil || !shallow {
		return errors.New("not a shallow checkout")
	}
	name := strings.TrimPrefix(ref, "refs/remotes/")
	if !strings.HasPrefix(name, "origin/") || name == "origin/HEAD" || strings.ContainsAny(name, " :^~?*[\\") || strings.Contains(name, "..") {
		return errors.New("default ref is not an origin branch")
	}
	branch := strings.TrimPrefix(name, "origin/")
	return gitdepth.FetchShallowRef(ctx, repoRoot, "+refs/heads/"+branch+":refs/remotes/origin/"+branch)
}

func fetchMissingCommit(ctx context.Context, repoRoot, sha string) error {
	shallow, err := gitdepth.IsShallow(ctx, repoRoot)
	if err != nil || !shallow {
		return errors.New("not a shallow checkout")
	}
	return gitdepth.FetchShallowRef(ctx, repoRoot, sha)
}

func resolveCommit(ctx context.Context, repoRoot, ref string) (string, error) {
	resolved, err := gitOutput(ctx, repoRoot, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(resolved))
	if !shaPattern.MatchString(sha) {
		return "", fmt.Errorf("ref %q did not resolve to a full Git SHA", ref)
	}
	return sha, nil
}

func listTree(ctx context.Context, repoRoot, headSHA, sourcePath string) (map[string]treeEntry, error) {
	output, err := gitOutput(ctx, repoRoot, "ls-tree", "-r", "-z", "--full-tree", headSHA, "--", sourcePathspec(sourcePath))
	if err != nil {
		return nil, fmt.Errorf("list source head tree: %w", err)
	}
	entries := strings.Split(string(output), "\x00")
	tree := make(map[string]treeEntry, len(entries))
	prefix := ""
	if sourcePath != "." {
		prefix = sourcePath + "/"
	}
	for _, raw := range entries {
		if raw == "" {
			continue
		}
		metadata, filePath, ok := strings.Cut(raw, "\t")
		if !ok {
			return nil, fmt.Errorf("invalid git tree entry %q", raw)
		}
		fields := strings.Fields(metadata)
		if len(fields) != 3 {
			return nil, fmt.Errorf("invalid git tree metadata %q", metadata)
		}
		if !utf8.ValidString(filePath) {
			return nil, fmt.Errorf("source tree path is not valid UTF-8")
		}
		relative := filePath
		if prefix != "" {
			if !strings.HasPrefix(filePath, prefix) {
				continue
			}
			relative = strings.TrimPrefix(filePath, prefix)
		}
		if err := validateSourcePath(relative); err != nil {
			return nil, fmt.Errorf("source tree: %w", err)
		}
		tree[relative] = treeEntry{Mode: fields[0], Type: fields[1], SHA: fields[2], Path: filePath}
	}
	return tree, nil
}

func parseNameStatus(output []byte) ([]diffEntry, error) {
	parts := strings.Split(string(output), "\x00")
	changes := make([]diffEntry, 0)
	for cursor := 0; cursor < len(parts); {
		status := parts[cursor]
		cursor++
		if status == "" {
			continue
		}
		kind := string(status[0])
		if kind == "R" || kind == "C" {
			if cursor+1 >= len(parts) {
				return nil, errors.New("git returned an incomplete rename/copy record")
			}
			oldPath, newPath := parts[cursor], parts[cursor+1]
			cursor += 2
			if !utf8.ValidString(oldPath) || !utf8.ValidString(newPath) {
				return nil, errors.New("changed source path is not valid UTF-8")
			}
			changes = append(changes, diffEntry{Status: kind, OldPath: oldPath, NewPath: newPath, Path: newPath})
			continue
		}
		if cursor >= len(parts) {
			return nil, errors.New("git returned an incomplete name-status record")
		}
		filePath := parts[cursor]
		cursor++
		if !utf8.ValidString(filePath) {
			return nil, errors.New("changed source path is not valid UTF-8")
		}
		changes = append(changes, diffEntry{Status: kind, Path: filePath, NewPath: filePath})
	}
	return changes, nil
}

func makeChangesSourceRelative(changes []diffEntry, sourcePath string) ([]diffEntry, error) {
	prefix := ""
	if sourcePath != "." {
		prefix = sourcePath + "/"
	}
	for index := range changes {
		for _, value := range []*string{&changes[index].OldPath, &changes[index].NewPath, &changes[index].Path} {
			if *value == "" {
				continue
			}
			if prefix != "" && !strings.HasPrefix(*value, prefix) {
				return nil, fmt.Errorf("Git diff path %q is outside registered source path %q", *value, sourcePath)
			}
			if prefix != "" {
				*value = strings.TrimPrefix(*value, prefix)
			}
			if err := validateSourcePath(*value); err != nil {
				return nil, fmt.Errorf("changed source path: %w", err)
			}
		}
		if changes[index].NewPath != "" {
			changes[index].Path = changes[index].NewPath
		}
	}
	return changes, nil
}

func readTreeBlob(ctx context.Context, repoRoot string, entry treeEntry) ([]byte, error) {
	if err := validateTreeBlobEntry(entry); err != nil {
		return nil, err
	}
	content, err := gitOutput(ctx, repoRoot, "cat-file", "blob", entry.SHA)
	if err != nil {
		return nil, fmt.Errorf("read head snapshot file %q: %w", entry.Path, err)
	}
	return content, nil
}

func validateTreeBlobEntry(entry treeEntry) error {
	if entry.Type != "blob" || (entry.Mode != "100644" && entry.Mode != "100755") {
		return fmt.Errorf("preview source %q is not a regular file (mode %s)", entry.Path, entry.Mode)
	}
	return nil
}

func gitOutput(ctx context.Context, repoDir string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, "git", args...)
	command.Dir = repoDir
	var stderr strings.Builder
	command.Stderr = &stderr
	output, err := command.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return nil, fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return output, nil
}

func digestBundle(files map[string][]byte) string {
	paths := make([]string, 0, len(files))
	for filePath := range files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	hasher := sha256.New()
	for _, filePath := range paths {
		content := files[filePath]
		var length [8]byte
		binary.BigEndian.PutUint64(length[:], uint64(len(filePath)))
		_, _ = hasher.Write(length[:])
		_, _ = hasher.Write([]byte(filePath))
		binary.BigEndian.PutUint64(length[:], uint64(len(content)))
		_, _ = hasher.Write(length[:])
		_, _ = hasher.Write(content)
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil))
}

func sumFileBytes(files map[string][]byte) int64 {
	var total int64
	for _, body := range files {
		total += int64(len(body))
	}
	return total
}

func describeFiles(files map[string][]byte) []PreviewFile {
	paths := make([]string, 0, len(files))
	for filePath := range files {
		paths = append(paths, filePath)
	}
	sort.Strings(paths)
	result := make([]PreviewFile, 0, len(paths))
	for _, filePath := range paths {
		digest := sha256.Sum256(files[filePath])
		result = append(result, PreviewFile{
			Path:        filePath,
			SHA256:      hex.EncodeToString(digest[:]),
			ContentType: contentTypeFor(filePath),
		})
	}
	return result
}

var canonicalRepositoryOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

func normalizeRepository(value string) (string, error) {
	value = strings.TrimSpace(value)
	parts := strings.Split(value, "/")
	if len(parts) != 2 || !canonicalRepositoryOwnerPattern.MatchString(parts[0]) || !githubrepo.ValidRepositoryName(parts[1]) {
		return "", fmt.Errorf("repository %q must be owner/repository", value)
	}
	return value, nil
}
