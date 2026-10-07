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
			return nil, fmt.Errorf("validate site publish state HEAD: %w", err)
		}
		state, err := decodeSitePublishState(siteID, info, stateObject.Bytes)
		if err != nil {
			return nil, fmt.Errorf("validate site publish state: %w", err)
		}
		artifactPrefix := "_artifacts/" + siteID + "/"
		indexKey := "_indexes/" + siteID + "/index.json"
		prior := &indexer.PriorSiteState{Files: map[string]string{}, Documents: map[string]indexer.PriorDocument{}}
		indexDigest := ""
		for _, row := range state.Committed.Objects {
			if strings.HasPrefix(row.Key, artifactPrefix) {
				prior.Files[strings.TrimPrefix(row.Key, artifactPrefix)] = row.SHA256
			} else if row.Key == indexKey {
				indexDigest = row.SHA256
			}
		}
		if indexDigest == "" {
			return nil, nil
		}
		indexObject, _, err := backend.GetObject(ctx, indexKey)
		if errors.Is(err, ErrObjectNotFound) {
			return nil, nil
		}
		if err != nil {
			return nil, fmt.Errorf("read deployed site index: %w", err)
		}
		if sha256Hex(indexObject.Bytes) != indexDigest {
			return nil, nil
		}
		var deployed indexer.SiteIndex
		if err := json.Unmarshal(indexObject.Bytes, &deployed); err != nil {
			return nil, nil
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
