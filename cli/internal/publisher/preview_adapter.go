package publisher

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/preview"
)

const (
	previewImmutableCache = "public, max-age=0, s-maxage=300, must-revalidate"
	previewCatalogCache   = "public, max-age=0, s-maxage=60, must-revalidate"
)

type previewSiteLockContextKey struct{}

type previewSiteLock struct {
	site  string
	owner string
	etag  string
}

// ObjectPreviewStore adapts the provider-neutral deployment object API to the
// preview contract. It is shared by local, AWS and Cloudflare backends, so
// preview records and orchestration do not carry provider-specific types.
type ObjectPreviewStore struct {
	backend ConditionalObjectBackend
	locks   SiteLockManager
}

func NewObjectPreviewStore(backend ConditionalObjectBackend) (*ObjectPreviewStore, error) {
	if backend == nil {
		return nil, errors.New("conditional deployment backend is required")
	}
	return &ObjectPreviewStore{backend: backend, locks: SiteLockManager{Backend: backend}}, nil
}

var _ preview.PreviewStore = (*ObjectPreviewStore)(nil)

func (store *ObjectPreviewStore) WithSiteLock(ctx context.Context, site string, operation func(context.Context) error) error {
	if operation == nil {
		return errors.New("preview lock operation is required")
	}
	snapshot, release, err := store.locks.Acquire(ctx, site)
	if err != nil {
		return err
	}
	lockedContext := context.WithValue(ctx, previewSiteLockContextKey{}, previewSiteLock{
		site: snapshot.Site, owner: snapshot.Owner, etag: snapshot.ETag,
	})
	operationErr := operation(lockedContext)
	releaseErr := release()
	if operationErr != nil && releaseErr != nil {
		return errors.Join(operationErr, fmt.Errorf("release preview site lock: %w", releaseErr))
	}
	if operationErr != nil {
		return operationErr
	}
	if releaseErr != nil {
		return fmt.Errorf("release preview site lock: %w", releaseErr)
	}
	return nil
}

func (store *ObjectPreviewStore) ReadObject(ctx context.Context, key string) ([]byte, error) {
	objectKey, err := preview.RawObjectKey(key)
	if err != nil {
		return nil, err
	}
	object, _, err := store.backend.GetObject(ctx, objectKey)
	if errors.Is(err, ErrObjectNotFound) {
		return nil, preview.ErrObjectNotFound
	}
	if err != nil {
		return nil, err
	}
	return object.Bytes, nil
}

func (store *ObjectPreviewStore) CreateImmutableObject(ctx context.Context, key string, contents []byte) error {
	if err := store.verifyPreviewWriteScope(ctx, key); err != nil {
		return err
	}
	objectKey, err := preview.RawObjectKey(key)
	if err != nil {
		return err
	}
	_, err = store.backend.PutObjectConditional(ctx, objectKey, previewObject(objectKey, contents, previewImmutableCache), ObjectCondition{IfNoneMatch: true})
	if err == nil {
		return nil
	}
	if !errors.Is(err, ErrPreconditionFailed) {
		return err
	}
	existing, _, readErr := store.backend.GetObject(ctx, objectKey)
	if readErr != nil {
		return fmt.Errorf("read existing immutable preview object: %w", readErr)
	}
	if !bytes.Equal(existing.Bytes, contents) {
		return preview.ErrImmutableObjectConflict
	}
	return nil
}

func (store *ObjectPreviewStore) ReplaceMutableObject(ctx context.Context, key string, contents []byte) error {
	if err := store.verifyPreviewWriteScope(ctx, key); err != nil {
		return err
	}
	objectKey, err := preview.RawObjectKey(key)
	if err != nil {
		return err
	}
	if site, isCatalog := previewCatalogSite(objectKey); isCatalog {
		lock, ok := ctx.Value(previewSiteLockContextKey{}).(previewSiteLock)
		if !ok {
			return fmt.Errorf("preview catalog for site %q requires an active site lock", site)
		}
		if err := store.verifySiteLock(ctx, site, lock); err != nil {
			return err
		}
	}
	cache := previewImmutableCache
	if strings.HasSuffix(key, "/catalog.json") {
		cache = previewCatalogCache
	}
	return store.backend.PutObject(ctx, objectKey, previewObject(objectKey, contents, cache))
}

func (store *ObjectPreviewStore) verifyPreviewWriteScope(ctx context.Context, key string) error {
	objectKey, err := preview.RawObjectKey(key)
	if err != nil {
		return err
	}
	site, isPreviewObject := previewObjectSite(objectKey)
	if !isPreviewObject {
		return nil
	}
	lock, hasLock := ctx.Value(previewSiteLockContextKey{}).(previewSiteLock)
	if hasLock && lock.site != site {
		return fmt.Errorf("preview object for site %q cannot be written under %q site lock", site, lock.site)
	}
	return nil
}

func (store *ObjectPreviewStore) verifySiteLock(ctx context.Context, site string, expected previewSiteLock) error {
	if expected.site != site || expected.owner == "" || expected.etag == "" {
		return fmt.Errorf("preview catalog for site %q is not covered by the active site lock", site)
	}
	object, etag, err := store.backend.GetObject(ctx, siteLockKey(site))
	if err != nil {
		return fmt.Errorf("verify preview site lock before catalog replacement: %w", err)
	}
	if etag != expected.etag {
		return fmt.Errorf("preview site lock for %q changed before catalog replacement: %w", site, ErrPreconditionFailed)
	}
	record, err := decodeLockRecord(object.Bytes, site)
	if err != nil {
		return fmt.Errorf("verify preview site lock before catalog replacement: %w", err)
	}
	if record.State != "held" || record.Owner != expected.owner {
		return fmt.Errorf("preview site lock for %q is no longer owned by this publisher: %w", site, ErrPreconditionFailed)
	}
	return nil
}

func previewCatalogSite(key string) (string, bool) {
	parts := strings.Split(key, "/")
	if len(parts) != 3 || parts[0] != "_previews" || parts[2] != "catalog.json" || validateLockSite(parts[1]) != nil {
		return "", false
	}
	return parts[1], true
}

func previewObjectSite(key string) (string, bool) {
	parts := strings.Split(key, "/")
	if len(parts) < 3 || parts[0] != "_previews" || validateLockSite(parts[1]) != nil {
		return "", false
	}
	return parts[1], true
}

func previewObject(key string, contents []byte, cache string) Object {
	return Object{
		Bytes: contents, ContentType: contentType(key), ContentDisposition: "inline", Cache: cache,
		Metadata: map[string]string{"artifact-pages-preview": "true"},
	}
}
