package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
)

type siteCacheRetry struct {
	SchemaVersion   int                     `json:"schemaVersion"`
	Site            string                  `json:"site,omitempty"`
	Transaction     *sitePublishTransaction `json:"transaction,omitempty"`
	legacyRecord    bool
	legacyDetail    string
	legacyBytes     []byte
	legacyObject    Object
	legacyBackupKey string
}

type sitePublishTransaction struct {
	ID             string   `json:"id"`
	BaseGeneration string   `json:"baseGeneration"`
	TouchedKeys    []string `json:"touchedKeys"`
}

const (
	siteCacheRetrySchemaVersion = 2
	maxSiteCacheRetryBytes      = 16 << 20
)

func readSiteCacheRetry(ctx context.Context, backend ConditionalObjectBackend, site string) (siteCacheRetry, string, error) {
	object, etag, err := getSiteControl(ctx, backend, site, siteCacheRetryKey(site))
	if errors.Is(err, ErrObjectNotFound) {
		return siteCacheRetry{SchemaVersion: siteCacheRetrySchemaVersion, Site: site}, "", nil
	}
	if err != nil {
		return siteCacheRetry{}, "", fmt.Errorf("read site cache retry record: %w", err)
	}
	if strings.TrimSpace(etag) == "" {
		return siteCacheRetry{}, "", errors.New("site cache retry record has no ETag for compare-and-swap")
	}
	if len(object.Bytes) > maxSiteCacheRetryBytes {
		return siteCacheRetry{}, "", fmt.Errorf("site cache retry record exceeds %d bytes", maxSiteCacheRetryBytes)
	}
	if err := validateNoDuplicateJSONKeys(object.Bytes); err != nil {
		return siteCacheRetry{}, "", fmt.Errorf("validate site cache retry record: %w", err)
	}
	var header struct {
		SchemaVersion int `json:"schemaVersion"`
	}
	if err := json.Unmarshal(object.Bytes, &header); err != nil {
		return siteCacheRetry{}, "", errors.New("site cache retry record must be a JSON object")
	}
	if header.SchemaVersion != 1 && header.SchemaVersion != 2 {
		return siteCacheRetry{}, "", compat.CheckSchemaVersion("site cache retry record", object.Bytes, siteCacheRetrySchemaVersion)
	}
	decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
	if header.SchemaVersion == 1 {
		decoder.DisallowUnknownFields()

		var old struct {
			SchemaVersion int                     `json:"schemaVersion"`
			Site          string                  `json:"site,omitempty"`
			Paths         []string                `json:"paths"`
			Transaction   *sitePublishTransaction `json:"transaction,omitempty"`
		}
		if err := decoder.Decode(&old); err != nil {
			return siteCacheRetry{}, "", fmt.Errorf("decode legacy site cache retry record: %w", err)
		}
		if old.SchemaVersion != 1 || (old.Site != "" && old.Site != site) {
			return siteCacheRetry{}, "", errors.New("legacy site cache retry record does not match schema or selected site")
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return siteCacheRetry{}, "", errors.New("legacy site cache retry record must contain exactly one JSON value")
		}
		if err := validateLegacySiteCacheRetryPaths(site, old.Paths); err != nil {
			return siteCacheRetry{}, "", err
		}
		if old.Transaction != nil {
			if err := validateSitePublishTransaction(site, *old.Transaction); err != nil {
				return siteCacheRetry{}, "", err
			}
		}
		return siteCacheRetry{SchemaVersion: 2, Site: site, Transaction: old.Transaction, legacyRecord: true,
			legacyDetail: "schemaVersion 1 cache paths", legacyBytes: append([]byte(nil), object.Bytes...), legacyObject: cloneSiteControlObject(object), legacyBackupKey: siteLegacyCacheRetryBackupKey(site, object.Bytes)}, etag, nil
	}
	var record siteCacheRetry
	if err := decoder.Decode(&record); err != nil {
		return siteCacheRetry{}, "", fmt.Errorf("decode site cache journal: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return siteCacheRetry{}, "", errors.New("site cache journal must contain exactly one JSON value")
	}
	if record.SchemaVersion != 2 || record.Site != site {
		return siteCacheRetry{}, "", errors.New("site cache journal does not match schema or selected site")
	}
	if record.Transaction == nil {
		return siteCacheRetry{}, "", errors.New("site cache journal requires an origin transaction")
	}
	if err := validateSitePublishTransaction(site, *record.Transaction); err != nil {
		return siteCacheRetry{}, "", err
	}
	return record, etag, nil
}

func validateSiteCacheRetryRecord(site string, record siteCacheRetry) error {
	if record.SchemaVersion != siteCacheRetrySchemaVersion || record.Site != site || record.Transaction == nil {
		return errors.New("site cache journal has an invalid schema, site, or missing transaction")
	}
	return validateSitePublishTransaction(site, *record.Transaction)
}

func validateLegacySiteCacheRetryPaths(site string, paths []string) error {
	if paths == nil {
		return errors.New("site cache retry paths must be an array")
	}
	if len(paths) == 0 {
		return errors.New("invalid site cache retry record: paths must be non-empty")
	}
	for i, p := range paths {
		decoded, err := url.PathUnescape(p)
		if err != nil || strings.ContainsAny(p, "?#*") ||
			!(strings.HasPrefix(decoded, "/_artifacts/"+site+"/") || decoded == "/_indexes/"+site+"/index.json" || decoded == "/_indexes/"+site+"/meta.json" || strings.HasPrefix(decoded, "/_indexes/"+site+"/search/") || decoded == "/_previews/"+site+"/catalog.json") {
			return errors.New("site cache retry record contains an out-of-scope path")
		}
		for _, segment := range strings.Split(decoded, "/") {
			if segment == "." || segment == ".." {
				return errors.New("site cache retry record contains a traversal path")
			}
		}
		if i > 0 && paths[i-1] >= p {
			return errors.New("site cache retry paths must be sorted and unique")
		}
	}
	return nil
}

func validateSitePublishTransaction(site string, transaction sitePublishTransaction) error {
	if !sitePublishStateHashPattern.MatchString(transaction.ID) || !sitePublishStateHashPattern.MatchString(transaction.BaseGeneration) {
		return errors.New("site cache retry transaction has an invalid generation")
	}
	if transaction.ID == transaction.BaseGeneration {
		return errors.New("site cache retry transaction id must differ from its base generation")
	}
	if transaction.TouchedKeys == nil || len(transaction.TouchedKeys) == 0 {
		return errors.New("site cache retry transaction touchedKeys must be a non-empty array")
	}
	for i, key := range transaction.TouchedKeys {
		if err := validateSitePublishOwnedKey(site, key); err != nil {
			return fmt.Errorf("site cache retry transaction key %d: %w", i, err)
		}
		if i > 0 && transaction.TouchedKeys[i-1] >= key {
			return errors.New("site cache retry transaction touchedKeys must be sorted and unique")
		}
	}
	return nil
}

func siteCacheRetryNeedsWrite(current, next siteCacheRetry, exists bool) bool {
	if !exists {
		return true
	}
	if current.SchemaVersion != next.SchemaVersion || current.Site != next.Site {
		return true
	}
	if (current.Transaction == nil) != (next.Transaction == nil) {
		return true
	}
	if current.Transaction == nil {
		return false
	}
	return current.Transaction.ID != next.Transaction.ID || current.Transaction.BaseGeneration != next.Transaction.BaseGeneration ||
		!sameStringSlice(current.Transaction.TouchedKeys, next.Transaction.TouchedKeys)
}

func sameStringSlice(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for i := range left {
		if left[i] != right[i] {
			return false
		}
	}
	return true
}

func writeSiteCacheRetryRecord(ctx context.Context, backend ConditionalObjectBackend, site string, record siteCacheRetry, etag string) (string, error) {
	record.SchemaVersion = siteCacheRetrySchemaVersion
	record.Site = site
	if err := validateSiteCacheRetryRecord(site, record); err != nil {
		return "", err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return "", err
	}
	if len(data) > maxSiteCacheRetryBytes {
		return "", fmt.Errorf("site cache retry record exceeds %d bytes", maxSiteCacheRetryBytes)
	}
	condition := ObjectCondition{IfNoneMatch: true}
	if etag != "" {
		condition = ObjectCondition{IfMatchETag: etag}
	}
	newETag, err := backend.PutObjectConditional(ctx, siteCacheRetryKey(site), Object{Bytes: data, ContentType: "application/json; charset=utf-8", Cache: cacheControl(cacheClassPrivateControl)}, condition)
	if err != nil {
		return "", fmt.Errorf("save site cache retry record: %w", err)
	}
	if strings.TrimSpace(newETag) == "" {
		return "", errors.New("site cache retry write returned no ETag")
	}
	return newETag, nil
}
