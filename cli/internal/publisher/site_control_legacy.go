package publisher

import (
	"bytes"
	"context"
	"errors"
	"fmt"
)

func unfinishedSiteCacheRetryError(site string, legacyErr error) error {
	var formatErr *siteControlLegacyFormatError
	if !errors.As(legacyErr, &formatErr) {
		return legacyErr
	}
	return fmt.Errorf("site %q %s uses an older prerelease control format (%s) and has an unfinished cache retry; rerun with the CLI version that wrote it to finish the retry, or remove %s after confirming no publish is running",
		site, formatErr.Record, formatErr.Detail, siteCacheRetryKey(site))
}

func writeSiteControlLegacyBackup(ctx context.Context, backend ConditionalObjectBackend, key string, original Object) error {
	backup := cloneSiteControlObject(original)
	_, err := backend.PutObjectConditional(ctx, key, backup, ObjectCondition{IfNoneMatch: true})
	if err == nil {
		return nil
	}
	if !errors.Is(err, ErrPreconditionFailed) {
		return fmt.Errorf("save legacy site control backup %s: %w", key, err)
	}

	existing, _, err := backend.GetObject(ctx, key)
	if err != nil {
		return fmt.Errorf("read existing legacy site control backup %s: %w", key, err)
	}
	if !bytes.Equal(existing.Bytes, original.Bytes) {
		return fmt.Errorf("legacy publish-state backup %s exists with different bytes", key)
	}
	return nil
}

func cloneSiteControlObject(object Object) Object {
	clone := Object{
		Bytes:              append([]byte(nil), object.Bytes...),
		ContentType:        object.ContentType,
		ContentDisposition: object.ContentDisposition,
		ContentEncoding:    object.ContentEncoding,
		Cache:              object.Cache,
	}
	if object.Metadata != nil {
		clone.Metadata = make(map[string]string, len(object.Metadata))
		for key, value := range object.Metadata {
			clone.Metadata[key] = value
		}
	}
	return clone
}
