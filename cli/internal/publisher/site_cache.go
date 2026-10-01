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

	"github.com/tasuku43/git-artifact-pages/cli/internal/preview"
)

type siteCacheRetry struct {
	SchemaVersion int      `json:"schemaVersion"`
	Paths         []string `json:"paths"`
}

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
		return siteCacheRetry{SchemaVersion: 1}, "", nil
	}
	if err != nil {
		return siteCacheRetry{}, "", fmt.Errorf("read site cache retry record: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(object.Bytes))
	decoder.DisallowUnknownFields()
	var record siteCacheRetry
	if err := decoder.Decode(&record); err != nil {
		return record, "", fmt.Errorf("decode site cache retry record: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return record, "", errors.New("site cache retry record must contain exactly one JSON value")
	}
	if record.SchemaVersion != 1 || len(record.Paths) == 0 {
		return record, "", errors.New("invalid site cache retry record")
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
	return record, etag, nil
}

func writeSiteCacheRetry(ctx context.Context, backend ConditionalObjectBackend, site string, paths []string, etag string) error {
	data, err := json.Marshal(siteCacheRetry{SchemaVersion: 1, Paths: paths})
	if err != nil {
		return err
	}
	condition := ObjectCondition{IfNoneMatch: true}
	if etag != "" {
		condition = ObjectCondition{IfMatchETag: etag}
	}
	_, err = backend.PutObjectConditional(ctx, siteCacheRetryKey(site), Object{Bytes: data, ContentType: "application/json; charset=utf-8", Cache: "no-store"}, condition)
	if err != nil {
		return fmt.Errorf("save site cache retry record: %w", err)
	}
	return nil
}
