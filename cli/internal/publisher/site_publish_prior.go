package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
)

// sitePriorStateLoader supplies the deployed site's committed per-file
// hashes and per-document Git metadata to a shallow checkout, so history
// need not be fetched for documents whose inputs did not change. It performs
// reads only and is therefore safe in dry-run. The loader returns (nil, nil)
// whenever the committed state cannot vouch for the deployed index: no state
// root yet, or an index object whose bytes do not match the state's recorded
// digest (an interrupted transaction or out-of-band edit).
func sitePriorStateLoader(backend ConditionalObjectBackend, siteID string) indexer.PriorStateLoader {
	return func(ctx context.Context) (*indexer.PriorSiteState, error) {
		stateObject, etag, err := getSiteControl(ctx, backend, siteID, sitePublishStateKey(siteID))
		if errors.Is(err, ErrObjectNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read site publish state: %w", err)
		}
		info := sitePublishStateInfo(stateObject, etag)
		if err := validateSitePublishStateHead(siteID, info); err != nil {
			if errors.Is(err, errSiteControlLegacyFormat) {
				return nil, nil
			}
			return nil, fmt.Errorf("validate site publish state HEAD: %w", err)
		}
		state, err := decodeSitePublishState(siteID, info, stateObject.Bytes)
		if err != nil {
			if errors.Is(err, errSiteControlLegacyFormat) {
				return nil, nil
			}
			return nil, fmt.Errorf("validate site publish state: %w", err)
		}
		artifactPrefix := "_artifacts/" + siteID + "/"
		indexKey := "_indexes/" + siteID + "/index.json"
		prior := &indexer.PriorSiteState{Files: map[string]string{}, Documents: map[string]indexer.PriorDocument{}}
		var indexRow *sitePublishObject
		for _, row := range state.Committed.Objects {
			if strings.HasPrefix(row.Key, artifactPrefix) {
				prior.Files[strings.TrimPrefix(row.Key, artifactPrefix)] = row.SHA256
			} else if row.Key == indexKey {
				copy := row
				indexRow = &copy
			}
		}
		if indexRow == nil {
			return nil, nil
		}
		info, err = backend.HeadObject(ctx, indexKey)
		if errors.Is(err, ErrObjectNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("inspect deployed site index: %w", err)
		}
		if info.Size != indexRow.Size || info.Metadata["artifact-pages-sha256"] != indexRow.SHA256 {
			return nil, nil
		}
		if err := validatePriorSiteIndexMetadata(siteID, *indexRow, info.ContentType, info.ContentDisposition, info.ContentEncoding, info.CacheControl, info.Metadata); err != nil {
			return nil, fmt.Errorf("validate deployed site index metadata: %w", err)
		}
		indexObject, _, err := backend.GetObject(ctx, indexKey)
		if errors.Is(err, ErrObjectNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read deployed site index: %w", err)
		}
		if int64(len(indexObject.Bytes)) != indexRow.Size || sha256Hex(indexObject.Bytes) != indexRow.SHA256 {
			return nil, nil
		}
		if err := validatePriorSiteIndexMetadata(siteID, *indexRow, indexObject.ContentType, indexObject.ContentDisposition, indexObject.ContentEncoding, indexObject.Cache, indexObject.Metadata); err != nil {
			return nil, fmt.Errorf("validate deployed site index metadata: %w", err)
		}
		plain, err := decodeSiteGeneratedJSON(indexObject.Bytes, indexRow.ContentEncoding)
		if err != nil {
			return nil, fmt.Errorf("decode deployed site index: %w", err)
		}
		var deployed indexer.SiteIndex
		if err := json.Unmarshal(plain, &deployed); err != nil {
			return nil, fmt.Errorf("decode deployed site index JSON: %w", err)
		}
		for _, entry := range deployed.Artifacts {
			updatedAt, parseErr := time.Parse(time.RFC3339, entry.UpdatedAt)
			if parseErr != nil || entry.Path == "" {
				continue
			}
			document := indexer.PriorDocument{UpdatedAt: updatedAt.UTC()}
			if entry.LastCommitter != nil {
				document.LastCommitter = entry.LastCommitter.Name
			}
			prior.Documents[entry.Path] = document
		}
		return prior, nil
	}
}

func validatePriorSiteIndexMetadata(site string, row sitePublishObject, contentType, disposition, encoding, cache string, metadata map[string]string) error {
	if contentType != row.ContentType || (disposition != row.ContentDisposition && !(disposition == "" && row.ContentDisposition == "inline")) ||
		encoding != row.ContentEncoding || cache != row.CacheControl || metadata["artifact-pages-site"] != site || metadata["artifact-pages-sha256"] != row.SHA256 {
		return errors.New("deployed site index HTTP or object metadata does not match committed publish state")
	}
	if encoding != "" && encoding != "gzip" {
		return fmt.Errorf("unsupported deployed site index content encoding %q", encoding)
	}
	return nil
}
