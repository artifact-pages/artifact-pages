package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"sort"
	"strings"

	"github.com/tasuku43/git-artifact-pages/cli/internal/compat"
	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
)

type siteCacheRetry struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Site          string                  `json:"site,omitempty"`
	Paths         []string                `json:"paths"`
	Transaction   *sitePublishTransaction `json:"transaction,omitempty"`
}

type sitePublishTransaction struct {
	ID             string   `json:"id"`
	BaseGeneration string   `json:"baseGeneration"`
	TouchedKeys    []string `json:"touchedKeys"`
}

const (
	siteCacheRetrySchemaVersion = 1
	maxSiteCacheRetryBytes      = 16 << 20
)

func siteCacheRetryKey(site string) string { return "_control/site-cache/" + site + ".json" }

var siteResourcePathSpellings = strings.NewReplacer("%21", "!", "%27", "'", "%28", "(", "%29", ")", "%3B", ";", "%2C", ",")

func siteCachePaths(site string, changes []Change, previews *[]preview.CatalogReconciliationChange, pending []string) []string {
	set := make(map[string]bool)
	for _, p := range pending {
		set[p] = true
		set[siteResourcePathSpellings.Replace(p)] = true
	}
	for _, change := range changes {
		// Encode segments separately, including literal '*' (CloudFront's
		// wildcard character), so one filename cannot broaden a purge.
		segments := strings.Split(change.Path, "/")
		for i, segment := range segments {
			segments[i] = url.PathEscape(segment)
		}
		set["/"+strings.Join(segments, "/")] = true
		// Browsers can retain these safe ASCII characters in relative resource
		// URLs, whereas the reader's indexed URLs use PathEscape. Purge both
		// spellings. Never restore '*' here: it is a CDN wildcard, not a literal.
		resourcePath := siteResourcePathSpellings.Replace("/" + strings.Join(segments, "/"))
		set[resourcePath] = true
	}
	if countPreviewChanges(previews, "remove") > 0 {
		set["/_previews/"+site+"/catalog.json"] = true
	}
	paths := make([]string, 0, len(set))
	for p := range set {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	return paths
}

func readSiteCacheRetry(ctx context.Context, backend ConditionalObjectBackend, site string) (siteCacheRetry, string, error) {
	object, etag, err := backend.GetObject(ctx, siteCacheRetryKey(site))
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
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(object.Bytes, &envelope); err != nil || envelope == nil {
		return siteCacheRetry{}, "", errors.New("site cache retry record must be a JSON object")
	}
	versionRaw, ok := envelope["schemaVersion"]
	if !ok {
		return siteCacheRetry{}, "", errors.New("site cache retry record has no schemaVersion")
	}
	var version int
	if err := json.Unmarshal(versionRaw, &version); err != nil {
		return siteCacheRetry{}, "", errors.New("site cache retry record has an invalid schemaVersion")
	}
	if version != siteCacheRetrySchemaVersion {
		return siteCacheRetry{}, "", compat.CheckSchemaVersion("site cache retry record", object.Bytes, siteCacheRetrySchemaVersion)
	}
	if rawPaths, ok := envelope["paths"]; !ok || !rawJSONKind(rawPaths, "array") {
		return siteCacheRetry{}, "", errors.New("site cache retry record paths must be an array")
	}
	if rawSite, ok := envelope["site"]; !ok || !rawJSONKind(rawSite, "string") {
		return siteCacheRetry{}, "", sitePrivateControlFormatResetError(site, "cache-retry record", "missing selected-site field")
	}
	var recordedSite string
	if err := json.Unmarshal(envelope["site"], &recordedSite); err != nil || recordedSite != site {
		return siteCacheRetry{}, "", errors.New("site cache retry record does not match the selected site")
	}
	if transaction, ok := envelope["transaction"]; ok && !bytes.Equal(bytes.TrimSpace(transaction), []byte("null")) && !rawJSONKind(transaction, "object") {
		return siteCacheRetry{}, "", errors.New("site cache retry transaction must be an object")
	}
	decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
	var record siteCacheRetry
	if err := decoder.Decode(&record); err != nil {
		return record, "", fmt.Errorf("decode site cache retry record: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return record, "", errors.New("site cache retry record must contain exactly one JSON value")
	}
	if record.SchemaVersion != version {
		return record, "", errors.New("site cache retry schemaVersion changed while decoding")
	}
	if record.Site != site {
		return record, "", errors.New("site cache retry record does not match the selected site")
	}
	if len(record.Paths) == 0 {
		return record, "", errors.New("invalid site cache retry record: paths must be non-empty")
	}
	for i, p := range record.Paths {
		decoded, err := url.PathUnescape(p)
		if err != nil || strings.ContainsAny(p, "?#*") ||
			!(strings.HasPrefix(decoded, "/_artifacts/"+site+"/") || decoded == "/_indexes/"+site+"/index.json" || decoded == "/_indexes/"+site+"/meta.json" || strings.HasPrefix(decoded, "/_indexes/"+site+"/search/") || decoded == "/_previews/"+site+"/catalog.json") {
			return record, "", errors.New("site cache retry record contains an out-of-scope path")
		}
		for _, segment := range strings.Split(decoded, "/") {
			if segment == "." || segment == ".." {
				return record, "", errors.New("site cache retry record contains a traversal path")
			}
		}
		if i > 0 && record.Paths[i-1] >= p {
			return record, "", errors.New("site cache retry paths must be sorted and unique")
		}
	}
	if record.Transaction != nil {
		if err := validateSitePublishTransaction(site, *record.Transaction); err != nil {
			return record, "", err
		}
	}
	return record, etag, nil
}

func validateSiteCacheRetryRecord(site string, record siteCacheRetry) error {
	if record.SchemaVersion != siteCacheRetrySchemaVersion || record.Site != site {
		return errors.New("site cache retry record has an invalid schema or site")
	}
	if record.Paths == nil {
		return errors.New("site cache retry paths must be an array")
	}
	for i, p := range record.Paths {
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
		if i > 0 && record.Paths[i-1] >= p {
			return errors.New("site cache retry paths must be sorted and unique")
		}
	}
	if record.Transaction != nil {
		return validateSitePublishTransaction(site, *record.Transaction)
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
	if current.SchemaVersion != next.SchemaVersion || current.Site != next.Site || !sameStringSlice(current.Paths, next.Paths) {
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

func writeSiteCacheRetry(ctx context.Context, backend ConditionalObjectBackend, site string, paths []string, etag string) error {
	_, err := writeSiteCacheRetryRecord(ctx, backend, site, siteCacheRetry{Paths: paths}, etag)
	return err
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
	newETag, err := backend.PutObjectConditional(ctx, siteCacheRetryKey(site), Object{Bytes: data, ContentType: "application/json; charset=utf-8", Cache: "no-store"}, condition)
	if err != nil {
		return "", fmt.Errorf("save site cache retry record: %w", err)
	}
	if strings.TrimSpace(newETag) == "" {
		return "", errors.New("site cache retry write returned no ETag")
	}
	return newETag, nil
}
