package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// DirectoryBackend provides the same object projection operations as remote
// adapters while writing into a local static root. Cache invalidation is a
// no-op because local nginx serves the current files directly.
type DirectoryBackend struct {
	root string
}

// localStorageRoot identifies the local projection boundary for validation
// before a publish lock is created inside the deployment root.
func (backend *DirectoryBackend) localStorageRoot() string {
	return backend.root
}

func NewDirectoryBackend(root string) (*DirectoryBackend, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("local deployment root is required")
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve local deployment root: %w", err)
	}
	return &DirectoryBackend{root: filepath.Clean(absoluteRoot)}, nil
}

var _ DeploymentBackend = (*DirectoryBackend)(nil)
var _ ConditionalObjectBackend = (*DirectoryBackend)(nil)

func (backend *DirectoryBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, "", err
	}
	target, err := backend.objectPath(key)
	if err != nil {
		return Object{}, "", err
	}
	if err := rejectDeploymentSymlink(backend.root, target); err != nil {
		return Object{}, "", err
	}
	info, err := os.Lstat(target)
	if errors.Is(err, os.ErrNotExist) {
		return Object{}, "", ErrObjectNotFound
	}
	if err != nil {
		return Object{}, "", err
	}
	if !info.Mode().IsRegular() {
		return Object{}, "", fmt.Errorf("local deployment object is not a regular file: %s", key)
	}
	contents, err := os.ReadFile(target)
	if err != nil {
		return Object{}, "", err
	}
	sum := sha256.Sum256(contents)
	return Object{Bytes: contents}, `"` + hex.EncodeToString(sum[:]) + `"`, nil
}

func (backend *DirectoryBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	object, etag, err := backend.GetObject(ctx, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	sum := sha256.Sum256(object.Bytes)
	cacheControl := ""
	if strings.HasPrefix(key, "_indexes/") {
		cacheControl = indexCacheControl
	} else if strings.HasPrefix(key, "_artifacts/") {
		cacheControl = artifactCacheControl
	} else {
		cacheControl = appFileCacheControl(key)
	}
	return ObjectInfo{
		ETag: etag, Size: int64(len(object.Bytes)), ContentType: contentType(key), ContentDisposition: "inline",
		CacheControl: cacheControl,
		Metadata:     map[string]string{"artifact-pages-sha256": hex.EncodeToString(sum[:])},
	}, nil
}

func (backend *DirectoryBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	target, err := backend.objectPath(key)
	if err != nil {
		return "", err
	}
	if condition.IfNoneMatch && condition.IfMatchETag != "" {
		return "", errors.New("conditional object write cannot use both If-Match and If-None-Match")
	}
	mutexPath := filepath.Join(backend.root, "_control", "transactions", filepath.Base(target)+".mutex")
	if err := withLocalObjectMutex(ctx, backend.root, mutexPath, func() error {
		current, etag, readErr := backend.GetObject(ctx, key)
		_ = current
		if condition.IfNoneMatch {
			if readErr == nil {
				return ErrPreconditionFailed
			}
			if !errors.Is(readErr, ErrObjectNotFound) {
				return readErr
			}
		} else if condition.IfMatchETag != "" {
			if readErr != nil {
				if errors.Is(readErr, ErrObjectNotFound) {
					return ErrPreconditionFailed
				}
				return readErr
			}
			if etag != condition.IfMatchETag {
				return ErrPreconditionFailed
			}
		} else if readErr != nil && !errors.Is(readErr, ErrObjectNotFound) {
			return readErr
		}
		if err := rejectDeploymentSymlink(backend.root, target); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return atomicDeploymentWrite(target, object.Bytes, 0o644)
	}); err != nil {
		return "", err
	}
	sum := sha256.Sum256(object.Bytes)
	return `"` + hex.EncodeToString(sum[:]) + `"`, nil
}

func (backend *DirectoryBackend) PutObject(ctx context.Context, key string, object Object) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	target, err := backend.objectPath(key)
	if err != nil {
		return err
	}
	if err := rejectDeploymentSymlink(backend.root, target); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	if err := rejectDeploymentSymlink(backend.root, target); err != nil {
		return err
	}
	return atomicDeploymentWrite(target, object.Bytes, 0o644)
}

func (backend *DirectoryBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if prefix == "" {
		return nil, errors.New("local deployment listing prefix is required")
	}
	base, err := backend.objectPath(strings.TrimSuffix(prefix, "/"))
	if err != nil {
		return nil, err
	}
	if err := rejectDeploymentSymlink(backend.root, base); err != nil {
		return nil, err
	}
	info, err := os.Lstat(base)
	if errors.Is(err, os.ErrNotExist) {
		return []string{}, nil
	}
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("local deployment listing path contains a symlink: %s", base)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("local deployment listing prefix is not a directory: %s", base)
	}
	var keys []string
	err = filepath.WalkDir(base, func(filePath string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("local deployment listing contains a symlink: %s", filePath)
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("local deployment listing contains a non-regular file: %s", filePath)
		}
		relative, err := filepath.Rel(backend.root, filePath)
		if err != nil {
			return err
		}
		keys = append(keys, filepath.ToSlash(relative))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(keys)
	return keys, nil
}

func (backend *DirectoryBackend) DeleteObjects(ctx context.Context, keys []string) error {
	for _, key := range keys {
		if err := ctx.Err(); err != nil {
			return err
		}
		target, err := backend.objectPath(key)
		if err != nil {
			return err
		}
		if err := rejectDeploymentSymlink(backend.root, target); err != nil {
			return err
		}
		if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove local object %s: %w", key, err)
		}
		if err := removeEmptyDeploymentDirectories(backend.root, filepath.Dir(target)); err != nil {
			return fmt.Errorf("clean empty local object directories for %s: %w", key, err)
		}
	}
	return nil
}

func (backend *DirectoryBackend) Invalidate(ctx context.Context, _ []string) (string, error) {
	return "", ctx.Err()
}

func (backend *DirectoryBackend) objectPath(key string) (string, error) {
	if err := rejectDeploymentRootSymlink(backend.root); err != nil {
		return "", err
	}
	if key == "" || strings.ContainsAny(key, "\\\x00") || strings.HasPrefix(key, "/") || filepath.IsAbs(key) {
		return "", fmt.Errorf("invalid local deployment object key %q", key)
	}
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(key)))
	if cleaned != key || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("non-canonical local deployment object key %q", key)
	}
	target := filepath.Join(backend.root, filepath.FromSlash(key))
	relative, err := filepath.Rel(backend.root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("local deployment object key escapes its root")
	}
	return target, nil
}

func rejectDeploymentRootSymlink(root string) error {
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("local deployment root is a symlink: %s", root)
	}
	return nil
}

func rejectDeploymentSymlink(root, target string) error {
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("local deployment path escapes its root")
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
			return fmt.Errorf("local deployment path contains a symlink: %s", current)
		}
	}
	return nil
}

func removeEmptyDeploymentDirectories(root, directory string) error {
	for filepath.Clean(directory) != filepath.Clean(root) {
		if err := rejectDeploymentSymlink(root, directory); err != nil {
			return err
		}
		entries, err := os.ReadDir(directory)
		if errors.Is(err, os.ErrNotExist) {
			directory = filepath.Dir(directory)
			continue
		}
		if err != nil {
			return err
		}
		if len(entries) > 0 {
			return nil
		}
		if err := os.Remove(directory); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		directory = filepath.Dir(directory)
	}
	return nil
}

func atomicDeploymentWrite(target string, contents []byte, mode os.FileMode) error {
	temporary, err := os.CreateTemp(filepath.Dir(target), ".artifact-pages-tmp-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
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
	return os.Rename(temporaryPath, target)
}

func withLocalObjectMutex(ctx context.Context, root, mutexPath string, action func() error) error {
	if err := rejectDeploymentSymlink(root, mutexPath); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(mutexPath), 0o700); err != nil {
		return err
	}
	if err := rejectDeploymentSymlink(root, mutexPath); err != nil {
		return err
	}
	file, err := os.OpenFile(mutexPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
			return action()
		}
		if err != syscall.EWOULDBLOCK && err != syscall.EAGAIN {
			return fmt.Errorf("lock local object transaction: %w", err)
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
