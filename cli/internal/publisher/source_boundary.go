package publisher

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type localStorageRoot interface {
	localStorageRoot() string
}

// preflightLocalSourceBoundary is advisory about site eligibility: PublishSite
// still re-reads the authoritative registry after taking the site lock. The
// initial lookup exists only because the source path is otherwise unknown
// until after locking, and the lock itself would be written under that source.
func preflightLocalSourceBoundary(
	ctx context.Context,
	backend ConditionalObjectBackend,
	siteID, repositoryRoot, sourceDir string,
) error {
	localBackend, ok := backend.(localStorageRoot)
	if !ok {
		return nil
	}
	if sourceDir == "" {
		projection, err := loadOriginRegistry(ctx, backend)
		if err != nil {
			return err
		}
		entry, found := registrySite(projection, siteID)
		if !found {
			return siteNotRegistered(projection, siteID)
		}
		sourceDir = filepath.Join(repositoryRoot, filepath.FromSlash(entry.SourcePath))
	}
	return rejectOverlappingLocalSource(localBackend.localStorageRoot(), sourceDir)
}

func rejectOverlappingLocalSource(storageRoot, sourceDir string) error {
	storagePath, err := canonicalPathForOverlap(storageRoot)
	if err != nil {
		return fmt.Errorf("resolve local deployment root: %w", err)
	}
	sourcePath, err := canonicalPathForOverlap(sourceDir)
	if err != nil {
		return fmt.Errorf("resolve site source directory: %w", err)
	}
	if pathsOverlap(storagePath, sourcePath) {
		return fmt.Errorf("local deployment root %q overlaps site source %q; choose disjoint paths", storageRoot, sourceDir)
	}
	return nil
}

func canonicalPathForOverlap(value string) (string, error) {
	absolute, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	current := filepath.Clean(absolute)
	var missing []string
	for {
		_, statErr := os.Lstat(current)
		if statErr == nil {
			resolved, resolveErr := filepath.EvalSymlinks(current)
			if resolveErr != nil {
				return "", resolveErr
			}
			for index := len(missing) - 1; index >= 0; index-- {
				resolved = filepath.Join(resolved, missing[index])
			}
			return filepath.Clean(resolved), nil
		}
		if !errors.Is(statErr, os.ErrNotExist) {
			return "", statErr
		}
		parent := filepath.Dir(current)
		if parent == current {
			return current, nil
		}
		missing = append(missing, filepath.Base(current))
		current = parent
	}
}

func pathsOverlap(left, right string) bool {
	return pathWithin(left, right) || pathWithin(right, left)
}

func pathWithin(parent, candidate string) bool {
	relative, err := filepath.Rel(parent, candidate)
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}
