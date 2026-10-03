package publisher

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
)

const (
	sitePublishStateSchemaVersion = 1
	maxSitePublishStateGzipBytes  = 16 << 20
	maxSitePublishStateJSONBytes  = 64 << 20
	sitePublishStateCacheControl  = "no-store"
)

var (
	sitePublishStateHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	sitePublishStateSearchBlob  = regexp.MustCompile(`^(root|leaf)-[0-9a-f]{64}\.gz$`)
)

// sitePublishState is the complete committed snapshot used by the publisher's
// state fast path and its recoverable pending-write transaction.
type sitePublishState struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Site          string               `json:"site"`
	Committed     sitePublishCommitted `json:"committed"`
	Pending       *sitePublishPending  `json:"pending,omitempty"`
}

type sitePublishCommitted struct {
	InputRoot string              `json:"inputRoot"`
	Objects   []sitePublishObject `json:"objects"`
}

type sitePublishObject struct {
	Key                string `json:"key"`
	SHA256             string `json:"sha256"`
	Size               int64  `json:"size"`
	ContentType        string `json:"contentType"`
	ContentEncoding    string `json:"contentEncoding"`
	ContentDisposition string `json:"contentDisposition"`
	CacheControl       string `json:"cacheControl"`
}

type sitePublishPending struct {
	TouchedKeys []string `json:"touchedKeys"`
}

// sitePublishStateKey is intentionally a single mutable key per site. The
// leading underscore keeps publisher coordination objects outside user routes.
func sitePublishStateKey(site string) string {
	return "_control/publish-state/" + site + ".json.gz"
}

// encodeSitePublishState validates and serializes state as deterministic gzip
// bytes. The JSON field order follows the structs above; no clock, filename,
// or platform value is embedded in the gzip header.
func encodeSitePublishState(state sitePublishState) ([]byte, error) {
	if err := validateSitePublishState(state, state.Site); err != nil {
		return nil, err
	}
	plain, err := json.Marshal(state)
	if err != nil {
		return nil, fmt.Errorf("encode site publish state JSON: %w", err)
	}
	if len(plain) > maxSitePublishStateJSONBytes {
		return nil, fmt.Errorf("site publish state JSON exceeds %d bytes", maxSitePublishStateJSONBytes)
	}
	var compressed bytes.Buffer
	writer, err := gzip.NewWriterLevel(&compressed, gzip.BestCompression)
	if err != nil {
		return nil, fmt.Errorf("create site publish state gzip writer: %w", err)
	}
	writer.Header.ModTime = time.Time{}
	writer.Header.Name = ""
	writer.Header.Comment = ""
	writer.Header.OS = 255
	if _, err := writer.Write(plain); err != nil {
		return nil, fmt.Errorf("compress site publish state: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("finish site publish state gzip: %w", err)
	}
	if compressed.Len() > maxSitePublishStateGzipBytes {
		return nil, fmt.Errorf("site publish state gzip exceeds %d bytes", maxSitePublishStateGzipBytes)
	}
	return compressed.Bytes(), nil
}

// validateSitePublishStateHead validates all writer-controlled HEAD fields.
// The body digest is syntax-checked here and checked against bytes by Decode.
// A non-empty ETag is required because every state transition is a CAS.
func validateSitePublishStateHead(site string, info ObjectInfo) error {
	if err := validateStateSite(site); err != nil {
		return err
	}
	if strings.TrimSpace(info.ETag) == "" {
		return errors.New("site publish state HEAD has no ETag for compare-and-swap")
	}
	if info.Size <= 0 || info.Size > maxSitePublishStateGzipBytes {
		return fmt.Errorf("site publish state HEAD size must be between 1 and %d bytes", maxSitePublishStateGzipBytes)
	}
	if info.ContentType != "application/octet-stream" || info.ContentEncoding != "" || info.CacheControl != sitePublishStateCacheControl ||
		(info.ContentDisposition != "" && info.ContentDisposition != "inline") {
		return errors.New("site publish state HEAD has unexpected HTTP metadata")
	}
	if len(info.Metadata) != len(sitePublishStateMetadataKeys) {
		return errors.New("site publish state HEAD has missing or unknown metadata")
	}
	for key := range info.Metadata {
		if _, ok := sitePublishStateMetadataKeys[key]; !ok {
			return fmt.Errorf("site publish state HEAD has unknown metadata %q", key)
		}
	}
	metadata := info.Metadata
	if metadata["artifact-pages-publish-state-schema"] != fmt.Sprint(sitePublishStateSchemaVersion) {
		return errors.New("site publish state HEAD has an unsupported schema")
	}
	if metadata["artifact-pages-site"] != site {
		return errors.New("site publish state HEAD site does not match the selected site")
	}
	root := metadata["artifact-pages-publish-input-root"]
	if root != "" && !sitePublishStateHashPattern.MatchString(root) {
		return errors.New("site publish state HEAD has an invalid input root")
	}
	if pending := metadata["artifact-pages-publish-pending"]; pending != "true" && pending != "false" {
		return errors.New("site publish state HEAD has an invalid pending flag")
	}
	if !sitePublishStateHashPattern.MatchString(metadata["artifact-pages-sha256"]) {
		return errors.New("site publish state HEAD has an invalid compressed SHA256")
	}
	return nil
}

var sitePublishStateMetadataKeys = map[string]struct{}{
	"artifact-pages-publish-state-schema": {},
	"artifact-pages-publish-input-root":   {},
	"artifact-pages-publish-pending":      {},
	"artifact-pages-sha256":               {},
	"artifact-pages-site":                 {},
}

// decodeSitePublishState validates the bounded gzip body, strict JSON syntax,
// ownership policy, and all HEAD/body bindings before returning usable state.
func decodeSitePublishState(site string, info ObjectInfo, body []byte) (sitePublishState, error) {
	if err := validateSitePublishStateHead(site, info); err != nil {
		return sitePublishState{}, err
	}
	if int64(len(body)) != info.Size {
		return sitePublishState{}, errors.New("site publish state body size does not match HEAD")
	}
	if len(body) > maxSitePublishStateGzipBytes {
		return sitePublishState{}, fmt.Errorf("site publish state gzip exceeds %d bytes", maxSitePublishStateGzipBytes)
	}
	if sha256Hex(body) != info.Metadata["artifact-pages-sha256"] {
		return sitePublishState{}, errors.New("site publish state body SHA256 does not match HEAD")
	}
	plain, err := decompressSitePublishState(body)
	if err != nil {
		return sitePublishState{}, err
	}
	if !utf8.Valid(plain) {
		return sitePublishState{}, errors.New("site publish state JSON is not valid UTF-8")
	}
	if err := validateNoDuplicateJSONKeys(plain); err != nil {
		return sitePublishState{}, fmt.Errorf("validate site publish state JSON: %w", err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(plain, &envelope); err != nil {
		return sitePublishState{}, fmt.Errorf("decode site publish state JSON: %w", err)
	}
	if envelope == nil {
		return sitePublishState{}, errors.New("site publish state must be a JSON object")
	}
	versionRaw, ok := envelope["schemaVersion"]
	if !ok {
		return sitePublishState{}, errors.New("site publish state has no schemaVersion")
	}
	var version int
	if err := json.Unmarshal(versionRaw, &version); err != nil {
		return sitePublishState{}, errors.New("site publish state has an invalid schemaVersion")
	}
	if version != sitePublishStateSchemaVersion {
		return sitePublishState{}, fmt.Errorf("unsupported site publish state schema version %d", version)
	}
	if err := requireStateJSONFields(envelope, map[string]string{
		"site": "string", "committed": "object",
	}); err != nil {
		return sitePublishState{}, err
	}
	if err := requireCommittedJSONFields(envelope["committed"]); err != nil {
		return sitePublishState{}, err
	}
	if pendingRaw, exists := envelope["pending"]; exists {
		if err := requirePendingJSONFields(pendingRaw); err != nil {
			return sitePublishState{}, err
		}
	}
	if err := requireStateObjectRows(envelope["committed"]); err != nil {
		return sitePublishState{}, err
	}
	var state sitePublishState
	if err := json.Unmarshal(plain, &state); err != nil {
		return sitePublishState{}, fmt.Errorf("decode site publish state: %w", err)
	}
	if err := validateSitePublishState(state, site); err != nil {
		return sitePublishState{}, err
	}
	metadata := info.Metadata
	if state.SchemaVersion != sitePublishStateSchemaVersion || state.Site != site ||
		state.Committed.InputRoot != metadata["artifact-pages-publish-input-root"] ||
		(state.Pending != nil) != (metadata["artifact-pages-publish-pending"] == "true") {
		return sitePublishState{}, errors.New("site publish state body does not match HEAD metadata")
	}
	return state, nil
}

// buildSitePublishStateObject returns the exact object policy used for private
// state. The SHA metadata covers the gzip bytes stored in Bytes.
func buildSitePublishStateObject(site string, state sitePublishState) (Object, error) {
	if err := validateStateSite(site); err != nil {
		return Object{}, err
	}
	if state.Site != site {
		return Object{}, errors.New("site publish state site does not match object key")
	}
	compressed, err := encodeSitePublishState(state)
	if err != nil {
		return Object{}, err
	}
	pending := "false"
	if state.Pending != nil {
		pending = "true"
	}
	return Object{
		Bytes:              compressed,
		ContentType:        "application/octet-stream",
		ContentEncoding:    "",
		ContentDisposition: "",
		Cache:              sitePublishStateCacheControl,
		Metadata: map[string]string{
			"artifact-pages-publish-state-schema": fmt.Sprint(sitePublishStateSchemaVersion),
			"artifact-pages-publish-input-root":   state.Committed.InputRoot,
			"artifact-pages-publish-pending":      pending,
			"artifact-pages-sha256":               sha256Hex(compressed),
			"artifact-pages-site":                 site,
		},
	}, nil
}

func validateStateSite(site string) error {
	if err := registry.ValidateSiteID(site); err != nil {
		return fmt.Errorf("invalid site publish state site: %w", err)
	}
	return nil
}

func validateSitePublishState(state sitePublishState, site string) error {
	if err := validateStateSite(site); err != nil {
		return err
	}
	if state.SchemaVersion != sitePublishStateSchemaVersion {
		return fmt.Errorf("unsupported site publish state schema version %d", state.SchemaVersion)
	}
	if state.Site != site {
		return errors.New("site publish state site does not match the selected site")
	}
	if state.Committed.InputRoot != "" && !sitePublishStateHashPattern.MatchString(state.Committed.InputRoot) {
		return errors.New("site publish state has an invalid committed input root")
	}
	if state.Committed.Objects == nil {
		return errors.New("site publish state committed objects must be an array")
	}
	previous := ""
	for i, row := range state.Committed.Objects {
		if err := validateSitePublishRow(site, row); err != nil {
			return fmt.Errorf("site publish state object %d: %w", i, err)
		}
		if i > 0 && row.Key <= previous {
			return errors.New("site publish state objects must be sorted by unique key")
		}
		previous = row.Key
	}
	if state.Pending != nil {
		if state.Pending.TouchedKeys == nil || len(state.Pending.TouchedKeys) == 0 {
			return errors.New("site publish state pending touchedKeys must be a non-empty array")
		}
		previous = ""
		for i, key := range state.Pending.TouchedKeys {
			if err := validateSitePublishOwnedKey(site, key); err != nil {
				return fmt.Errorf("site publish state pending key %d: %w", i, err)
			}
			if i > 0 && key <= previous {
				return errors.New("site publish state pending touchedKeys must be sorted and unique")
			}
			previous = key
		}
	}
	return nil
}

func validateSitePublishRow(site string, row sitePublishObject) error {
	if !sitePublishStateHashPattern.MatchString(row.SHA256) {
		return errors.New("sha256 must be 64 lowercase hexadecimal characters")
	}
	if row.Size < 0 {
		return errors.New("size must not be negative")
	}
	if err := validateSitePublishOwnedKey(site, row.Key); err != nil {
		return err
	}
	expectedType, expectedDisposition, expectedEncoding, expectedCache, err := expectedSitePublishObjectPolicy(site, row.Key)
	if err != nil {
		return err
	}
	if row.ContentType != expectedType || row.ContentDisposition != expectedDisposition || row.ContentEncoding != expectedEncoding || row.CacheControl != expectedCache {
		return fmt.Errorf("key %q has unknown HTTP policy", row.Key)
	}
	return nil
}

func validateSitePublishOwnedKey(site, key string) error {
	if !utf8.ValidString(key) || key == "" || strings.ContainsRune(key, '\x00') || strings.Contains(key, `\`) || strings.HasPrefix(key, "/") {
		return fmt.Errorf("key %q is not a valid site-owned storage key", key)
	}
	artifactPrefix := "_artifacts/" + site + "/"
	if strings.HasPrefix(key, artifactPrefix) {
		relative := strings.TrimPrefix(key, artifactPrefix)
		if relative == "" || path.Clean(relative) != relative || relative == "." || relative == ".." || strings.HasPrefix(relative, "../") || path.IsAbs(relative) {
			return fmt.Errorf("artifact key %q is not a canonical relative path", key)
		}
		for _, segment := range strings.Split(relative, "/") {
			if segment == "" || segment == "." || segment == ".." {
				return fmt.Errorf("artifact key %q is not a canonical relative path", key)
			}
		}
		return nil
	}
	indexPrefix := "_indexes/" + site + "/"
	if strings.HasPrefix(key, indexPrefix) {
		relative := strings.TrimPrefix(key, indexPrefix)
		if relative == "" || path.Clean(relative) != relative || relative == "." || relative == ".." || strings.HasPrefix(relative, "../") || path.IsAbs(relative) {
			return fmt.Errorf("index key %q is not a canonical relative path", key)
		}
		for _, segment := range strings.Split(relative, "/") {
			if segment == "" || segment == "." || segment == ".." {
				return fmt.Errorf("index key %q is not a canonical relative path", key)
			}
		}
		return nil
	}
	return fmt.Errorf("key %q is outside the selected site's managed object scope", key)
}

func expectedSitePublishObjectPolicy(site, key string) (contentType, disposition, encoding, cache string, err error) {
	if strings.HasPrefix(key, "_artifacts/"+site+"/") {
		relative := strings.TrimPrefix(key, "_artifacts/"+site+"/")
		return contentTypeForSiteArtifact(relative), "inline", "", artifactCacheControl, nil
	}
	indexPrefix := "_indexes/" + site + "/"
	switch {
	case key == indexPrefix+"index.json", key == indexPrefix+"meta.json", key == indexPrefix+"search/manifest.json":
		return "application/json; charset=utf-8", "inline", "", indexCacheControl, nil
	case strings.HasPrefix(key, indexPrefix+"search/") && sitePublishStateSearchBlob.MatchString(strings.TrimPrefix(key, indexPrefix+"search/")):
		return "application/octet-stream", "inline", "", immutableCache, nil
	default:
		return "", "", "", "", fmt.Errorf("key %q has no known site publish HTTP policy", key)
	}
}

// Keep artifact policy coupled to the publisher's existing extension map.
func contentTypeForSiteArtifact(relative string) string { return contentType(relative) }

func decompressSitePublishState(body []byte) ([]byte, error) {
	if len(body) > maxSitePublishStateGzipBytes {
		return nil, fmt.Errorf("site publish state gzip exceeds %d bytes", maxSitePublishStateGzipBytes)
	}
	source := bytes.NewReader(body)
	reader, err := gzip.NewReader(source)
	if err != nil {
		return nil, fmt.Errorf("open site publish state gzip: %w", err)
	}
	reader.Multistream(false)
	plain, readErr := io.ReadAll(io.LimitReader(reader, maxSitePublishStateJSONBytes+1))
	closeErr := reader.Close()
	if readErr != nil {
		return nil, fmt.Errorf("read site publish state gzip: %w", readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close site publish state gzip: %w", closeErr)
	}
	if len(plain) > maxSitePublishStateJSONBytes {
		return nil, fmt.Errorf("site publish state JSON exceeds %d bytes", maxSitePublishStateJSONBytes)
	}
	if source.Len() != 0 {
		return nil, errors.New("site publish state gzip has trailing data or multiple members")
	}
	return plain, nil
}

// validateNoDuplicateJSONKeys walks the complete token stream so duplicate
// keys are rejected even inside unknown fields that the current schema ignores.
func validateNoDuplicateJSONKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return fmt.Errorf("trailing JSON data: %w", err)
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return errors.New("JSON object key is not a string")
			}
			if _, duplicate := seen[key]; duplicate {
				return fmt.Errorf("duplicate JSON object key %q", key)
			}
			seen[key] = struct{}{}
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return errors.New("malformed JSON object")
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return errors.New("malformed JSON array")
		}
	default:
		return fmt.Errorf("unexpected JSON delimiter %q", delimiter)
	}
	return nil
}

func requireStateJSONFields(value map[string]json.RawMessage, fields map[string]string) error {
	for name, kind := range fields {
		raw, exists := value[name]
		if !exists || !rawJSONKind(raw, kind) {
			return fmt.Errorf("site publish state field %q must be a %s", name, kind)
		}
	}
	return nil
}

func requireCommittedJSONFields(raw json.RawMessage) error {
	var committed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &committed); err != nil || committed == nil {
		return errors.New("site publish state committed field must be an object")
	}
	if err := requireStateJSONFields(committed, map[string]string{"inputRoot": "string", "objects": "array"}); err != nil {
		return err
	}
	return nil
}

func requirePendingJSONFields(raw json.RawMessage) error {
	var pending map[string]json.RawMessage
	if err := json.Unmarshal(raw, &pending); err != nil || pending == nil {
		return errors.New("site publish state pending field must be an object")
	}
	return requireStateJSONFields(pending, map[string]string{"touchedKeys": "array"})
}

func requireStateObjectRows(raw json.RawMessage) error {
	var committed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &committed); err != nil || committed == nil {
		return errors.New("site publish state committed field must be an object")
	}
	var rows []json.RawMessage
	if err := json.Unmarshal(committed["objects"], &rows); err != nil || rows == nil {
		return errors.New("site publish state committed objects must be an array")
	}
	const rowFields = "key sha256 size contentType contentEncoding contentDisposition cacheControl"
	for i, rawRow := range rows {
		var row map[string]json.RawMessage
		if err := json.Unmarshal(rawRow, &row); err != nil || row == nil {
			return fmt.Errorf("site publish state object %d must be an object", i)
		}
		fields := make(map[string]string)
		for _, name := range strings.Fields(rowFields) {
			kind := "string"
			if name == "size" {
				kind = "number"
			}
			fields[name] = kind
		}
		if err := requireStateJSONFields(row, fields); err != nil {
			return fmt.Errorf("site publish state object %d: %w", i, err)
		}
	}
	return nil
}

func rawJSONKind(raw json.RawMessage, kind string) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return false
	}
	switch kind {
	case "object":
		return trimmed[0] == '{'
	case "array":
		return trimmed[0] == '['
	case "string":
		return trimmed[0] == '"'
	case "number":
		var number json.Number
		decoder := json.NewDecoder(bytes.NewReader(trimmed))
		decoder.UseNumber()
		return decoder.Decode(&number) == nil
	default:
		return false
	}
}
