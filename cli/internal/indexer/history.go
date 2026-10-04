package indexer

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/gitdepth"
)

// PriorSiteState is the deployed site's committed state as far as Git metadata
// derivation needs it: the SHA-256 of every deployed source file and the
// updatedAt/lastCommitter of every deployed document.
type PriorSiteState struct {
	// Files maps source-relative paths to the SHA-256 (hex) of deployed bytes.
	Files map[string]string
	// Documents maps document paths to their deployed Git metadata.
	Documents map[string]PriorDocument
}

// PriorDocument is the Git metadata a document was last deployed with.
type PriorDocument struct {
	UpdatedAt     time.Time
	LastCommitter string
}

// PriorStateLoader reads the trusted deployed state. It returns (nil, nil)
// when no trustworthy state exists (first publish, or the deployed index no
// longer matches the committed state), and an error for read failures.
type PriorStateLoader func(ctx context.Context) (*PriorSiteState, error)

// resolveGitUpdates returns per-document Git metadata identical to a full
// clone's. A complete checkout takes the original path. A shallow checkout
// carries deployed metadata forward for documents whose rendering inputs are
// byte-identical to the deployed state and deepens history only until every
// remaining document's latest touching commit is a real (non-boundary) commit.
func resolveGitUpdates(ctx context.Context, repositoryRoot, sourcePath string, artifacts []discoveredArtifact, files []SourceFileSnapshot, loader PriorStateLoader) (map[string]artifactGitUpdate, error) {
	shallow, err := gitdepth.IsShallow(ctx, repositoryRoot)
	if err != nil {
		return nil, fmt.Errorf("detect shallow Git checkout: %w", err)
	}
	if !shallow {
		return artifactGitUpdates(ctx, repositoryRoot, sourcePath, artifacts)
	}
	tip, err := gitOutput(ctx, repositoryRoot, "rev-parse", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("resolve HEAD of shallow checkout: %w", err)
	}
	tip = strings.TrimSpace(tip)
	var prior *PriorSiteState
	if loader != nil {
		if prior, err = loader(ctx); err != nil {
			return nil, fmt.Errorf("read deployed site state for shallow checkout: %w", err)
		}
	}
	if prior == nil {
		// No trustworthy deployed metadata to carry forward: history is the only source.
		if err := gitdepth.Unshallow(ctx, repositoryRoot, tip); err != nil {
			return nil, err
		}
		return artifactGitUpdates(ctx, repositoryRoot, sourcePath, artifacts)
	}
	fileHashes := make(map[string]string, len(files))
	for _, file := range files {
		fileHashes[file.RelativePath] = file.SHA256
	}
	unchanged := unchangedDocuments(artifacts, fileHashes, prior)
	for step := 0; ; step++ {
		boundaries, err := gitdepth.Boundaries(ctx, repositoryRoot)
		if err != nil {
			return nil, err
		}
		history, err := readArtifactGitHistory(ctx, repositoryRoot, sourcePath, artifacts, boundaries)
		if err != nil {
			return nil, err
		}
		if !hasAmbiguousDocument(artifacts, unchanged, history) {
			return mergePriorGitUpdates(history, unchanged, prior), nil
		}
		switch {
		case step < len(gitdepth.DeepenSteps):
			err = gitdepth.Deepen(ctx, repositoryRoot, gitdepth.DeepenSteps[step], tip)
		case step == len(gitdepth.DeepenSteps):
			err = gitdepth.Unshallow(ctx, repositoryRoot, tip)
		default:
			return nil, fmt.Errorf("cannot resolve Git history for changed documents in a shallow checkout; check out with full history (fetch-depth: 0)")
		}
		if err != nil {
			return nil, err
		}
	}
}

// hasAmbiguousDocument reports whether any changed document's newest touching
// commit could be hidden behind a shallow boundary. A boundary commit is
// parentless and therefore "touches" every file; a result is trustworthy only
// when a real commit touching the document is strictly newer than every
// boundary commit that touches it.
func hasAmbiguousDocument(artifacts []discoveredArtifact, unchanged map[string]struct{}, history artifactGitHistory) bool {
	for _, artifact := range artifacts {
		if _, carried := unchanged[artifact.relative]; carried {
			continue
		}
		boundary, touchedByBoundary := history.boundaryTime[artifact.relative]
		if !touchedByBoundary {
			continue
		}
		if visible := history.visible[artifact.relative]; visible.updatedAt.IsZero() || !visible.updatedAt.After(boundary) {
			return true
		}
	}
	return false
}

func mergePriorGitUpdates(history artifactGitHistory, unchanged map[string]struct{}, prior *PriorSiteState) map[string]artifactGitUpdate {
	result := make(map[string]artifactGitUpdate, len(history.latest))
	for relative, update := range history.latest {
		result[relative] = update
		if _, carried := unchanged[relative]; !carried {
			continue
		}
		deployed := prior.Documents[relative]
		result[relative] = artifactGitUpdate{updatedAt: deployed.UpdatedAt.UTC(), lastCommitter: deployed.LastCommitter}
		// A real commit newer than the deployed value that still touches the
		// document (for example a revert to identical bytes) is visible
		// evidence the deployed value is stale.
		if visible := history.visible[relative]; visible.updatedAt.After(deployed.UpdatedAt) {
			result[relative] = visible
		}
	}
	return result
}

// unchangedDocuments selects documents whose Git metadata can be carried
// forward: a deployed value with a committer exists, and the document's whole
// attribution scope (its own file plus the nested non-document files that
// roll up into it) has the same paths and bytes under the same document
// layout as the deployed state.
func unchangedDocuments(artifacts []discoveredArtifact, currentFiles map[string]string, prior *PriorSiteState) map[string]struct{} {
	current := make([]string, 0, len(artifacts))
	for _, artifact := range artifacts {
		current = append(current, artifact.relative)
	}
	priorPaths := make([]string, 0, len(prior.Documents))
	for relative := range prior.Documents {
		priorPaths = append(priorPaths, relative)
	}
	currentScopes := documentScopeDigests(current, currentFiles)
	priorScopes := documentScopeDigests(priorPaths, prior.Files)
	// A source file removed since the deployment (a deleted document counts)
	// still appears in history and rolls up into whichever documents own its
	// path now, so those documents' metadata can have moved.
	invalidated := make(map[string]struct{})
	currentDirectories, currentByFile := artifactPathLookup(documentArtifacts(current))
	for removed := range prior.Files {
		if _, stillPresent := currentFiles[removed]; stillPresent {
			continue
		}
		for _, owner := range artifactPathsForFile(removed, currentDirectories, currentByFile) {
			invalidated[owner] = struct{}{}
		}
	}
	unchanged := make(map[string]struct{})
	for _, relative := range current {
		if _, stale := invalidated[relative]; stale {
			continue
		}
		deployed, exists := prior.Documents[relative]
		if !exists || deployed.LastCommitter == "" || deployed.UpdatedAt.IsZero() {
			continue
		}
		if currentScopes[relative] == priorScopes[relative] {
			unchanged[relative] = struct{}{}
		}
	}
	return unchanged
}

// documentScopeDigests mirrors artifactPathsForFile: a document file belongs
// only to itself; any other file belongs to every document in the nearest
// ancestor directory that holds documents (falling back to the root).
func documentScopeDigests(documents []string, files map[string]string) map[string]string {
	directories, byFile := artifactPathLookup(documentArtifacts(documents))
	perDirectory := make(map[string][]string)
	for file, digest := range files {
		if _, isDocument := byFile[file]; isDocument {
			continue
		}
		owners := artifactPathsForFile(file, directories, byFile)
		if len(owners) == 0 {
			continue
		}
		directory := path.Dir(owners[0])
		perDirectory[directory] = append(perDirectory[directory], file+"\x00"+digest)
	}
	directoryDigest := make(map[string]string, len(perDirectory))
	for directory, lines := range perDirectory {
		sort.Strings(lines)
		hasher := sha256.New()
		for _, line := range lines {
			hasher.Write([]byte(line))
			hasher.Write([]byte{'\n'})
		}
		directoryDigest[directory] = hex.EncodeToString(hasher.Sum(nil))
	}
	result := make(map[string]string, len(documents))
	for _, relative := range documents {
		own, hasOwn := files[relative]
		hasher := sha256.New()
		fmt.Fprintf(hasher, "%t\x00%s\x00%s\x00%s", hasOwn, relative, own, directoryDigest[path.Dir(relative)])
		result[relative] = hex.EncodeToString(hasher.Sum(nil))
	}
	return result
}

func documentArtifacts(documents []string) []discoveredArtifact {
	artifacts := make([]discoveredArtifact, 0, len(documents))
	for _, relative := range documents {
		artifacts = append(artifacts, discoveredArtifact{relative: relative, fileRelative: relative, directoryRelative: path.Dir(relative)})
	}
	return artifacts
}
