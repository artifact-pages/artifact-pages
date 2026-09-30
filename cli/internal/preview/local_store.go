package preview

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// DirectoryStore writes the canonical preview object keys beneath a local
// directory. It is the Phase 1 development implementation of PreviewStore.
// Its site lock coordinates callers in this process only.
type DirectoryStore struct {
	root string
}

var localSiteLocks = struct {
	sync.Mutex
	locks map[string]*sync.Mutex
}{locks: make(map[string]*sync.Mutex)}

func NewDirectoryStore(root string) (*DirectoryStore, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("local preview root is required")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve local preview root: %w", err)
	}
	return &DirectoryStore{root: filepath.Clean(absoluteRoot)}, nil
}

// WriteLocal preserves the focused local development entry point while using
// the same provider-neutral publication flow as future store adapters.
func WriteLocal(previewRoot string, result BuildResult) error {
	store, err := NewDirectoryStore(previewRoot)
	if err != nil {
		return err
	}
	return Publish(context.Background(), store, result)
}

func (store *DirectoryStore) WithSiteLock(ctx context.Context, site string, operation func(context.Context) error) error {
	if !validSiteID(site) {
		return fmt.Errorf("invalid preview site identifier %q", site)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	lockKey := filepath.Join(store.root, site)
	localSiteLocks.Lock()
	lock := localSiteLocks.locks[lockKey]
	if lock == nil {
		lock = &sync.Mutex{}
		localSiteLocks.locks[lockKey] = lock
	}
	localSiteLocks.Unlock()
	lock.Lock()
	defer lock.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	return operation(ctx)
}

func (store *DirectoryStore) ReadObject(ctx context.Context, key string) ([]byte, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	target, err := store.objectPath(key)
	if err != nil {
		return nil, err
	}
	if err := rejectSymlinkPath(store.root, target); err != nil {
		return nil, err
	}
	contents, err := os.ReadFile(target)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrObjectNotFound
	}
	return contents, err
}

func (store *DirectoryStore) CreateImmutableObject(ctx context.Context, key string, contents []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	target, err := store.objectPath(key)
	if err != nil {
		return err
	}
	if err := rejectSymlinkPath(store.root, target); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if err := rejectSymlinkPath(store.root, target); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".preview-tmp-*")
	if err != nil {
		return err
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)
	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Chmod(0o644); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryName, target); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := rejectSymlinkPath(store.root, target); err != nil {
		return err
	}
	existing, err := os.ReadFile(target)
	if err != nil {
		return fmt.Errorf("read existing immutable preview object: %w", err)
	}
	if !bytes.Equal(existing, contents) {
		return ErrImmutableObjectConflict
	}
	return nil
}

func (store *DirectoryStore) ReplaceMutableObject(ctx context.Context, key string, contents []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	target, err := store.objectPath(key)
	if err != nil {
		return err
	}
	if err := rejectSymlinkPath(store.root, target); err != nil {
		return err
	}
	return atomicWrite(target, contents, 0o644)
}

func (store *DirectoryStore) objectPath(key string) (string, error) {
	rawKey, err := RawObjectKey(key)
	if err != nil {
		return "", err
	}
	const prefix = "_previews/"
	return filepath.Join(store.root, filepath.FromSlash(strings.TrimPrefix(rawKey, prefix))), nil
}

func rejectSymlinkPath(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("preview object path escapes local root")
	}
	current := root
	for _, segment := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, segment)
		info, statErr := os.Lstat(current)
		if errors.Is(statErr, os.ErrNotExist) {
			return nil
		}
		if statErr != nil {
			return statErr
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("preview object path contains a symlink: %s", current)
		}
	}
	return nil
}

func atomicWrite(target string, contents []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(target), ".preview-tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if _, err := temporary.Write(contents); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Chmod(mode); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, target)
}
