package publisher

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
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

type localStoredObjectMetadata struct {
	ContentType        string                            `json:"contentType"`
	ContentDisposition string                            `json:"contentDisposition"`
	ContentEncoding    string                            `json:"contentEncoding"`
	CacheControl       string                            `json:"cacheControl"`
	Metadata           map[string]string                 `json:"metadata,omitempty"`
	BodySHA256         string                            `json:"bodySha256"`
	Pending            bool                              `json:"pending,omitempty"`
	Previous           *localStoredObjectMetadataVersion `json:"previous,omitempty"`
}

type localStoredObjectMetadataVersion struct {
	ContentType        string            `json:"contentType"`
	ContentDisposition string            `json:"contentDisposition"`
	ContentEncoding    string            `json:"contentEncoding"`
	CacheControl       string            `json:"cacheControl"`
	Metadata           map[string]string `json:"metadata,omitempty"`
	BodySHA256         string            `json:"bodySha256"`
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
	metadata, metadataErr := backend.readStoredObjectMetadata(key, contents)
	if metadataErr != nil && !errors.Is(metadataErr, os.ErrNotExist) {
		return Object{}, "", metadataErr
	}
	sum := sha256.Sum256(contents)
	object := Object{Bytes: contents}
	if metadataErr == nil {
		object.ContentType = metadata.ContentType
		object.ContentDisposition = metadata.ContentDisposition
		object.ContentEncoding = metadata.ContentEncoding
		object.Cache = metadata.CacheControl
		object.Metadata = cloneObjectMetadata(metadata.Metadata)
	}
	return object, `"` + hex.EncodeToString(sum[:]) + `"`, nil
}

func (backend *DirectoryBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	object, etag, err := backend.GetObject(ctx, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	sum := sha256.Sum256(object.Bytes)
	digest := hex.EncodeToString(sum[:])
	cacheControl, objectType := "", contentType(key)
	if strings.HasPrefix(key, "_indexes/") && strings.HasSuffix(key, ".gz") {
		// Content-addressed full-text search blobs; the publisher writes them as opaque immutable bytes.
		cacheControl, objectType = immutableCache, "application/octet-stream"
	} else if strings.HasPrefix(key, "_indexes/") {
		cacheControl = indexCacheControl
	} else if strings.HasPrefix(key, "_artifacts/") {
		cacheControl = artifactCacheControl
	} else {
		cacheControl = appFileCacheControl(key)
	}
	info := ObjectInfo{
		ETag: etag, Size: int64(len(object.Bytes)), ContentType: objectType, ContentDisposition: "inline",
		CacheControl: cacheControl,
		Metadata:     map[string]string{"artifact-pages-sha256": digest},
	}
	metadata, metadataErr := backend.readStoredObjectMetadata(key, object.Bytes)
	if metadataErr != nil && !errors.Is(metadataErr, os.ErrNotExist) {
		return ObjectInfo{}, metadataErr
	}
	if metadataErr == nil {
		if metadata.ContentType != "" {
			info.ContentType = metadata.ContentType
		}
		if metadata.ContentDisposition != "" {
			info.ContentDisposition = metadata.ContentDisposition
		}
		if metadata.ContentEncoding != "" {
			info.ContentEncoding = metadata.ContentEncoding
		}
		if metadata.CacheControl != "" {
			info.CacheControl = metadata.CacheControl
		}
		info.Metadata = cloneObjectMetadata(metadata.Metadata)
		if info.Metadata == nil {
			info.Metadata = make(map[string]string)
		}
		if info.Metadata["artifact-pages-sha256"] == "" {
			info.Metadata["artifact-pages-sha256"] = digest
		}
	}
	return info, nil
}

func (backend *DirectoryBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	target, err := backend.objectPath(key)
	if err != nil {
		return "", err
	}
	if condition.IfNoneMatch && condition.IfMatchETag != "" {
		return "", errors.New("conditional object write cannot use both If-Match and If-None-Match")
	}
	mutexPath := filepath.Join(backend.root, "_control", "transactions", localObjectMutexName(key))
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
		return backend.writeObjectWithMetadata(key, target, object)
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
	mutexPath := filepath.Join(backend.root, "_control", "transactions", localObjectMutexName(key))
	return withLocalObjectMutex(ctx, backend.root, mutexPath, func() error {
		if err := rejectDeploymentSymlink(backend.root, target); err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if err := rejectDeploymentSymlink(backend.root, target); err != nil {
			return err
		}
		return backend.writeObjectWithMetadata(key, target, object)
	})
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
		if !strings.HasSuffix(prefix, "/") && info.Mode().IsRegular() {
			return []string{strings.TrimSuffix(prefix, "/")}, nil
		}
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
		metadataPath, err := backend.storedObjectMetadataPath(key)
		if err != nil {
			return err
		}
		if err := os.Remove(metadataPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove local object metadata %s: %w", key, err)
		}
		if err := removeEmptyDeploymentDirectories(backend.root, filepath.Dir(target)); err != nil {
			return fmt.Errorf("clean empty local object directories for %s: %w", key, err)
		}
	}
	return nil
}

func (backend *DirectoryBackend) storedObjectMetadataPath(key string) (string, error) {
	if _, err := backend.objectPath(key); err != nil {
		return "", err
	}
	metadataRoot := backend.root + ".metadata"
	if err := rejectDeploymentRootSymlink(metadataRoot); err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(key))
	return filepath.Join(metadataRoot, hex.EncodeToString(sum[:])+".json"), nil
}

func (backend *DirectoryBackend) readStoredObjectMetadata(key string, body []byte) (localStoredObjectMetadata, error) {
	metadataPath, err := backend.storedObjectMetadataPath(key)
	if err != nil {
		return localStoredObjectMetadata{}, err
	}
	if err := rejectDeploymentSymlink(backend.root+".metadata", metadataPath); err != nil {
		return localStoredObjectMetadata{}, err
	}
	data, err := os.ReadFile(metadataPath)
	if err != nil {
		return localStoredObjectMetadata{}, err
	}
	var record localStoredObjectMetadata
	if err := json.Unmarshal(data, &record); err != nil {
		return localStoredObjectMetadata{}, fmt.Errorf("decode local metadata for %s: %w", key, err)
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	selected, matches := metadataVersion(record), record.BodySHA256 == digest
	if !matches && record.Previous != nil && record.Previous.BodySHA256 == digest {
		selected, matches = *record.Previous, true
	}
	if !matches {
		if record.Pending || strings.HasPrefix(key, "_control/publish-state/") {
			return localStoredObjectMetadata{}, fmt.Errorf("local metadata journal for %s matches neither current nor previous object bytes", key)
		}
		// Ordinary local object edits are an out-of-band drift that explicit
		// --reconcile must be able to observe. Keep the committed HTTP policy,
		// but report the bytes actually on disk through the stored SHA field.
		selected.BodySHA256 = digest
		if selected.Metadata != nil && selected.Metadata["artifact-pages-sha256"] != "" {
			selected.Metadata = cloneObjectMetadata(selected.Metadata)
			selected.Metadata["artifact-pages-sha256"] = digest
		}
	}
	if customDigest := selected.Metadata["artifact-pages-sha256"]; customDigest != "" && customDigest != digest {
		return localStoredObjectMetadata{}, fmt.Errorf("local SHA-256 metadata for %s does not match object bytes", key)
	}
	return localStoredObjectMetadata{
		ContentType: selected.ContentType, ContentDisposition: selected.ContentDisposition,
		ContentEncoding: selected.ContentEncoding, CacheControl: selected.CacheControl,
		Metadata: cloneObjectMetadata(selected.Metadata), BodySHA256: selected.BodySHA256,
	}, nil
}

func (backend *DirectoryBackend) writeObjectWithMetadata(key, target string, object Object) error {
	metadataPath, err := backend.storedObjectMetadataPath(key)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o700); err != nil {
		return err
	}
	if err := rejectDeploymentSymlink(backend.root+".metadata", metadataPath); err != nil {
		return err
	}
	var previous *localStoredObjectMetadataVersion
	oldBytes, readErr := os.ReadFile(target)
	if readErr == nil {
		oldMetadata, metadataErr := backend.readStoredObjectMetadata(key, oldBytes)
		if metadataErr != nil && !errors.Is(metadataErr, os.ErrNotExist) {
			return metadataErr
		}
		oldVersion := metadataVersion(oldMetadata)
		if errors.Is(metadataErr, os.ErrNotExist) {
			oldDigest := sha256.Sum256(oldBytes)
			oldVersion.BodySHA256 = hex.EncodeToString(oldDigest[:])
		}
		previous = &oldVersion
	} else if !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	next := metadataVersionForObject(object)
	journal := localStoredObjectMetadata{
		ContentType: next.ContentType, ContentDisposition: next.ContentDisposition,
		ContentEncoding: next.ContentEncoding, CacheControl: next.CacheControl,
		Metadata: cloneObjectMetadata(next.Metadata), BodySHA256: next.BodySHA256,
		Pending: true, Previous: previous,
	}
	data, err := json.Marshal(journal)
	if err != nil {
		return fmt.Errorf("encode local metadata journal for %s: %w", key, err)
	}
	if err := atomicDeploymentWrite(metadataPath, data, 0o600); err != nil {
		return err
	}
	if err := atomicDeploymentWrite(target, object.Bytes, 0o644); err != nil {
		return err
	}
	if !hasCustomObjectMetadata(object) {
		if err := os.Remove(metadataPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	committed := localStoredObjectMetadata{
		ContentType: next.ContentType, ContentDisposition: next.ContentDisposition,
		ContentEncoding: next.ContentEncoding, CacheControl: next.CacheControl,
		Metadata: cloneObjectMetadata(next.Metadata), BodySHA256: next.BodySHA256,
	}
	data, err = json.Marshal(committed)
	if err != nil {
		return fmt.Errorf("encode local metadata for %s: %w", key, err)
	}
	return atomicDeploymentWrite(metadataPath, data, 0o600)
}

func metadataVersion(metadata localStoredObjectMetadata) localStoredObjectMetadataVersion {
	return localStoredObjectMetadataVersion{
		ContentType: metadata.ContentType, ContentDisposition: metadata.ContentDisposition,
		ContentEncoding: metadata.ContentEncoding, CacheControl: metadata.CacheControl,
		Metadata: cloneObjectMetadata(metadata.Metadata), BodySHA256: metadata.BodySHA256,
	}
}

func metadataVersionForObject(object Object) localStoredObjectMetadataVersion {
	bodyDigest := sha256.Sum256(object.Bytes)
	return localStoredObjectMetadataVersion{
		ContentType: object.ContentType, ContentDisposition: object.ContentDisposition,
		ContentEncoding: object.ContentEncoding, CacheControl: object.Cache,
		Metadata: cloneObjectMetadata(object.Metadata), BodySHA256: hex.EncodeToString(bodyDigest[:]),
	}
}

func hasCustomObjectMetadata(object Object) bool {
	return object.ContentType != "" || object.ContentDisposition != "" || object.ContentEncoding != "" || object.Cache != "" || len(object.Metadata) > 0
}

func localObjectMutexName(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:]) + ".mutex"
}

func cloneObjectMetadata(metadata map[string]string) map[string]string {
	if metadata == nil {
		return nil
	}
	clone := make(map[string]string, len(metadata))
	for key, value := range metadata {
		clone[key] = value
	}
	return clone
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
	// The storage root is served to readers; only the control records below it
	// are private. Without this, a fresh root would be created 0700 together
	// with the mutex directory and a web server running as another user could
	// not read the published objects.
	if err := os.MkdirAll(root, 0o755); err != nil {
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
