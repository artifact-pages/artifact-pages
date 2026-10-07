package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

const (
	appCacheRetryObjectKey = "_control/app-cache/retry.json"
	appCacheRetrySchema    = 1
	maxAppCacheRetryBytes  = 16 << 10
)

var appCacheRetryPathAllowlist = map[string]struct{}{
	"/LICENSE":                 {},
	"/THIRD_PARTY_NOTICES.txt": {},
	"/assets/*":                {},
	"/index.html":              {},
	"/preview-bridge.js":       {},
}

// appCacheRetry records the application URL paths that still need cache
// invalidation after a deployment attempt.
type appCacheRetry struct {
	SchemaVersion int      `json:"schemaVersion"`
	Paths         []string `json:"paths"`
}

func validateAppCacheRetry(record appCacheRetry) error {
	if record.SchemaVersion != appCacheRetrySchema {
		return fmt.Errorf("app cache retry record has unsupported schemaVersion %d", record.SchemaVersion)
	}
	if record.Paths == nil || len(record.Paths) == 0 {
		return errors.New("app cache retry paths must be a non-empty array")
	}
	for index, path := range record.Paths {
		if path == "" {
			return errors.New("app cache retry paths must not contain empty values")
		}
		if _, ok := appCacheRetryPathAllowlist[path]; !ok {
			return fmt.Errorf("app cache retry path %q is not supported", path)
		}
		if index > 0 && record.Paths[index-1] >= path {
			return errors.New("app cache retry paths must be sorted and unique")
		}
	}
	return nil
}

func readAppCacheRetry(ctx context.Context, backend ConditionalObjectBackend) (appCacheRetry, string, error) {
	object, etag, err := backend.GetObject(ctx, appCacheRetryObjectKey)
	if errors.Is(err, ErrObjectNotFound) {
		return appCacheRetry{SchemaVersion: appCacheRetrySchema, Paths: []string{}}, "", nil
	}
	if err != nil {
		return appCacheRetry{}, "", fmt.Errorf("read app cache retry record: %w", err)
	}
	if strings.TrimSpace(etag) == "" {
		return appCacheRetry{}, "", errors.New("app cache retry record has no ETag for compare-and-swap")
	}
	if len(object.Bytes) > maxAppCacheRetryBytes {
		return appCacheRetry{}, "", fmt.Errorf("app cache retry record exceeds %d bytes", maxAppCacheRetryBytes)
	}
	if err := validateNoDuplicateJSONKeys(object.Bytes); err != nil {
		return appCacheRetry{}, "", fmt.Errorf("validate app cache retry record: %w", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(object.Bytes, &envelope); err != nil || envelope == nil {
		return appCacheRetry{}, "", errors.New("app cache retry record must be a JSON object")
	}
	versionRaw, ok := envelope["schemaVersion"]
	if !ok {
		return appCacheRetry{}, "", errors.New("app cache retry record has no schemaVersion")
	}
	pathsRaw, ok := envelope["paths"]
	if !ok || !rawJSONKind(pathsRaw, "array") {
		return appCacheRetry{}, "", errors.New("app cache retry paths must be an array")
	}
	var record appCacheRetry
	if err := json.Unmarshal(versionRaw, &record.SchemaVersion); err != nil {
		return appCacheRetry{}, "", errors.New("app cache retry record has an invalid schemaVersion")
	}
	if err := json.Unmarshal(pathsRaw, &record.Paths); err != nil {
		return appCacheRetry{}, "", fmt.Errorf("decode app cache retry paths: %w", err)
	}
	if err := validateAppCacheRetry(record); err != nil {
		return appCacheRetry{}, "", err
	}
	return record, etag, nil
}

func writeAppCacheRetry(ctx context.Context, backend ConditionalObjectBackend, record appCacheRetry, etag string) (string, error) {
	if err := validateAppCacheRetry(record); err != nil {
		return "", err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return "", fmt.Errorf("encode app cache retry record: %w", err)
	}
	if len(data) > maxAppCacheRetryBytes {
		return "", fmt.Errorf("app cache retry record exceeds %d bytes", maxAppCacheRetryBytes)
	}
	condition := ObjectCondition{IfNoneMatch: true}
	if strings.TrimSpace(etag) != "" {
		condition = ObjectCondition{IfMatchETag: etag}
	}
	newETag, err := backend.PutObjectConditional(ctx, appCacheRetryObjectKey, Object{
		Bytes: data, ContentType: "application/json; charset=utf-8", Cache: "no-store",
	}, condition)
	if err != nil {
		return "", fmt.Errorf("write app cache retry record: %w", err)
	}
	if strings.TrimSpace(newETag) == "" {
		return "", errors.New("app cache retry write returned no ETag")
	}
	return newETag, nil
}

func clearAppCacheRetry(ctx context.Context, backend DeploymentBackend) error {
	if err := backend.DeleteObjects(ctx, []string{appCacheRetryObjectKey}); err != nil {
		return fmt.Errorf("clear app cache retry record: %w", err)
	}
	return nil
}
