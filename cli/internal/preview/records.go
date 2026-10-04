package preview

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tasuku43/git-artifact-pages/cli/internal/compat"
	"io"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const SchemaVersion = 1

type Catalog struct {
	SchemaVersion int     `json:"schemaVersion"`
	Site          string  `json:"site"`
	Groups        []Group `json:"groups"`
}

type Group struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`
	HeadSHA   string     `json:"headSha"`
	PRURL     string     `json:"prUrl,omitempty"`
	UpdatedAt string     `json:"updatedAt"`
	Documents []Document `json:"documents"`
}

type RevisionManifest struct {
	SchemaVersion int           `json:"schemaVersion"`
	Site          string        `json:"site"`
	HeadSHA       string        `json:"headSha"`
	DefaultHead   string        `json:"defaultHeadSha"`
	MergeBase     string        `json:"mergeBaseSha"`
	CreatedAt     string        `json:"createdAt"`
	BundleDigest  string        `json:"bundleDigest"`
	Files         []PreviewFile `json:"files"`
	Documents     []Document    `json:"documents"`
}

type PreviewFile struct {
	Path        string `json:"path"`
	SHA256      string `json:"sha256"`
	ContentType string `json:"contentType"`
}

// Document reasons record why a document is part of a preview.
const (
	ReasonChanged    = "changed"
	ReasonDependency = "dependency"
)

type Document struct {
	Path   string `json:"path"`
	Title  string `json:"title"`
	Format string `json:"format"`
	// Reason is "changed" for added or modified documents and "dependency" for
	// unchanged documents whose rendering resources changed. Manifests written
	// before the field existed omit it and read as "changed".
	Reason string `json:"reason,omitempty"`
	// ChangedResources lists, sorted, the changed resources that pulled a
	// dependency document into the preview.
	ChangedResources []string `json:"changedResources,omitempty"`
}

var (
	siteIDPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)
	shaPattern    = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
	digestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	prIDPattern   = regexp.MustCompile(`^pr:([1-9][0-9]*)$`)
)

func CatalogKey(siteID string) (string, error) {
	if !validSiteID(siteID) {
		return "", fmt.Errorf("invalid preview site identifier %q", siteID)
	}
	return "/_previews/" + encodeSegment(siteID) + "/catalog.json", nil
}

func ManifestKey(siteID, headSHA string) (string, error) {
	if !validSiteID(siteID) {
		return "", fmt.Errorf("invalid preview site identifier %q", siteID)
	}
	if !shaPattern.MatchString(headSHA) {
		return "", fmt.Errorf("invalid full Git head SHA %q", headSHA)
	}
	return "/_previews/" + encodeSegment(siteID) + "/revisions/" + headSHA + "/manifest.json", nil
}

func FileKey(siteID, headSHA, sourcePath string) (string, error) {
	manifest, err := ManifestKey(siteID, headSHA)
	if err != nil {
		return "", err
	}
	if err := validateSourcePath(sourcePath); err != nil {
		return "", err
	}
	return strings.TrimSuffix(manifest, "/manifest.json") + "/files/" + encodePath(sourcePath), nil
}

// RawObjectKey validates a canonical PreviewStore key and returns its storage
// key with each URL-encoded path segment decoded exactly once. Provider object
// keys and local files preserve the original UTF-8 source names; this value is
// not a URL and must not be URL-decoded again.
func RawObjectKey(key string) (string, error) {
	const prefix = "/_previews/"
	if !strings.HasPrefix(key, prefix) {
		return "", fmt.Errorf("preview object key %q is outside the preview namespace", key)
	}

	encodedParts := strings.Split(strings.TrimPrefix(key, prefix), "/")
	parts := make([]string, len(encodedParts))
	for index, encoded := range encodedParts {
		decoded, err := url.PathUnescape(encoded)
		if err != nil || decoded == "" || !utf8.ValidString(decoded) || strings.ContainsAny(decoded, "/\\\x00") || decoded == "." || decoded == ".." {
			return "", fmt.Errorf("invalid preview object key %q", key)
		}
		parts[index] = decoded
	}

	var canonical string
	switch {
	case len(parts) == 2 && parts[1] == "catalog.json":
		canonical, _ = CatalogKey(parts[0])
	case len(parts) == 4 && parts[1] == "revisions" && parts[3] == "manifest.json":
		canonical, _ = ManifestKey(parts[0], parts[2])
	case len(parts) >= 5 && parts[1] == "revisions" && parts[3] == "files":
		canonical, _ = FileKey(parts[0], parts[2], strings.Join(parts[4:], "/"))
	default:
		return "", fmt.Errorf("invalid preview object key %q", key)
	}
	if canonical == "" || canonical != key {
		return "", fmt.Errorf("non-canonical preview object key %q", key)
	}
	return "_previews/" + strings.Join(parts, "/"), nil
}

func DocumentRouteHref(siteID, headSHA, sourcePath, groupID string) (string, error) {
	if _, err := ManifestKey(siteID, headSHA); err != nil {
		return "", err
	}
	if err := validateDocumentPath(sourcePath); err != nil {
		return "", err
	}
	href := "/" + encodeSegment(siteID) + "/_previews/" + headSHA + "/" + encodePath(sourcePath)
	if groupID != "" {
		if err := validateGroupID(groupID, "", ""); err != nil {
			return "", err
		}
		href += "?group=" + url.QueryEscape(groupID)
	}
	return href, nil
}

func EncodeCatalog(catalog Catalog) ([]byte, error) {
	if err := ValidateCatalog(catalog); err != nil {
		return nil, err
	}
	return encodeJSON(catalog)
}

func DecodeCatalog(data []byte) (Catalog, error) {
	var catalog Catalog
	if err := compat.CheckSchemaVersion("preview catalog", data, SchemaVersion); err != nil {
		return Catalog{}, err
	}
	if err := decodeStrict(data, &catalog); err != nil {
		return Catalog{}, fmt.Errorf("decode preview catalog: %w", err)
	}
	if err := ValidateCatalog(catalog); err != nil {
		return Catalog{}, err
	}
	return catalog, nil
}

func EncodeManifest(manifest RevisionManifest) ([]byte, error) {
	if err := ValidateManifest(manifest); err != nil {
		return nil, err
	}
	return encodeJSON(manifest)
}

func DecodeManifest(data []byte) (RevisionManifest, error) {
	var manifest RevisionManifest
	if err := compat.CheckSchemaVersion("preview revision manifest", data, SchemaVersion); err != nil {
		return RevisionManifest{}, err
	}
	if err := decodeStrict(data, &manifest); err != nil {
		return RevisionManifest{}, fmt.Errorf("decode preview revision manifest: %w", err)
	}
	if err := ValidateManifest(manifest); err != nil {
		return RevisionManifest{}, err
	}
	return manifest, nil
}

func ValidateCatalog(catalog Catalog) error {
	if catalog.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported preview catalog schema version %d", catalog.SchemaVersion)
	}
	if !validSiteID(catalog.Site) {
		return fmt.Errorf("invalid preview catalog site %q", catalog.Site)
	}
	seen := make(map[string]struct{}, len(catalog.Groups))
	for _, group := range catalog.Groups {
		if _, exists := seen[group.ID]; exists {
			return fmt.Errorf("duplicate preview group %q", group.ID)
		}
		seen[group.ID] = struct{}{}
		if err := validateGroupID(group.ID, group.Kind, group.HeadSHA); err != nil {
			return err
		}
		if group.Kind == "pull-request" {
			if err := validatePRURL(group.PRURL, group.ID); err != nil {
				return err
			}
		} else if group.PRURL != "" {
			return fmt.Errorf("manual preview group %q cannot carry a pull request URL", group.ID)
		}
		if err := validateTimestamp(group.UpdatedAt); err != nil {
			return fmt.Errorf("preview group %q updatedAt: %w", group.ID, err)
		}
		if err := validateDocuments(group.Documents); err != nil {
			return fmt.Errorf("preview group %q: %w", group.ID, err)
		}
	}
	return nil
}

func ValidateManifest(manifest RevisionManifest) error {
	if manifest.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported preview manifest schema version %d", manifest.SchemaVersion)
	}
	if !validSiteID(manifest.Site) {
		return fmt.Errorf("invalid preview manifest site %q", manifest.Site)
	}
	if !shaPattern.MatchString(manifest.HeadSHA) || !shaPattern.MatchString(manifest.DefaultHead) || !shaPattern.MatchString(manifest.MergeBase) {
		return errors.New("preview manifest requires full lowercase Git SHAs for headSha, defaultHeadSha, and mergeBaseSha")
	}
	if err := validateTimestamp(manifest.CreatedAt); err != nil {
		return fmt.Errorf("preview manifest createdAt: %w", err)
	}
	if !digestPattern.MatchString(manifest.BundleDigest) {
		return fmt.Errorf("invalid preview bundle digest %q", manifest.BundleDigest)
	}
	filesByPath := make(map[string]struct{}, len(manifest.Files))
	for _, file := range manifest.Files {
		if err := validateSourcePath(file.Path); err != nil {
			return fmt.Errorf("preview file: %w", err)
		}
		if _, exists := filesByPath[file.Path]; exists {
			return fmt.Errorf("duplicate preview file path %q", file.Path)
		}
		filesByPath[file.Path] = struct{}{}
		if !shaPattern.MatchString(file.SHA256) {
			return fmt.Errorf("invalid SHA-256 for preview file %q", file.Path)
		}
		if strings.TrimSpace(file.ContentType) == "" {
			return fmt.Errorf("preview file %q has no content type", file.Path)
		}
	}
	if err := validateDocuments(manifest.Documents); err != nil {
		return fmt.Errorf("preview manifest: %w", err)
	}
	for _, document := range manifest.Documents {
		if _, ok := filesByPath[document.Path]; !ok {
			return fmt.Errorf("preview document %q is not present in the file bundle", document.Path)
		}
	}
	return nil
}

func GroupIDForPR(number int) (string, error) {
	if number < 1 {
		return "", errors.New("pull request number must be positive")
	}
	return fmt.Sprintf("pr:%d", number), nil
}

func GroupIDForHead(headSHA string) (string, error) {
	if !shaPattern.MatchString(headSHA) {
		return "", fmt.Errorf("invalid full Git head SHA %q", headSHA)
	}
	return "head:" + headSHA, nil
}

func validateDocuments(documents []Document) error {
	seen := make(map[string]struct{}, len(documents))
	for _, document := range documents {
		if err := validateDocumentPath(document.Path); err != nil {
			return err
		}
		if _, exists := seen[document.Path]; exists {
			return fmt.Errorf("duplicate preview document path %q", document.Path)
		}
		seen[document.Path] = struct{}{}
		if strings.TrimSpace(document.Title) == "" {
			return fmt.Errorf("preview document %q has no title", document.Path)
		}
		switch document.Reason {
		case "", ReasonChanged:
			if len(document.ChangedResources) > 0 {
				return fmt.Errorf("preview document %q lists changed resources but is not a dependency document", document.Path)
			}
		case ReasonDependency:
			for _, resource := range document.ChangedResources {
				if err := validateSourcePath(resource); err != nil {
					return fmt.Errorf("preview document %q changed resource: %w", document.Path, err)
				}
			}
		default:
			return fmt.Errorf("preview document %q has invalid reason %q", document.Path, document.Reason)
		}
		expectedFormat := documentFormat(document.Path)
		if expectedFormat == "" || document.Format != expectedFormat {
			return fmt.Errorf("preview document %q has invalid format %q", document.Path, document.Format)
		}
	}
	return nil
}

func validateGroupID(id, kind, headSHA string) error {
	if match := prIDPattern.FindStringSubmatch(id); match != nil {
		if kind != "" && kind != "pull-request" {
			return fmt.Errorf("preview group %q must have kind pull-request", id)
		}
		if headSHA != "" && !shaPattern.MatchString(headSHA) {
			return fmt.Errorf("preview group %q requires a full head SHA", id)
		}
		return nil
	}
	if strings.HasPrefix(id, "head:") {
		sha := strings.TrimPrefix(id, "head:")
		if !shaPattern.MatchString(sha) || (headSHA != "" && sha != headSHA) {
			return fmt.Errorf("invalid manual preview group id %q", id)
		}
		if kind != "" && kind != "manual" {
			return fmt.Errorf("preview group %q must have kind manual", id)
		}
		return nil
	}
	return fmt.Errorf("invalid preview group id %q", id)
}

func validatePRURL(value, groupID string) error {
	if value == "" {
		return fmt.Errorf("pull request group %q has no canonical prUrl", groupID)
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil || strings.ContainsAny(value, "?#") {
		return fmt.Errorf("pull request group %q has an invalid canonical GitHub URL", groupID)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	match := prIDPattern.FindStringSubmatch(groupID)
	if len(parts) != 4 || parts[0] == "" || parts[1] == "" || parts[2] != "pull" || match == nil || parts[3] != match[1] {
		return fmt.Errorf("pull request URL %q does not match preview group %q", value, groupID)
	}
	if parsed.EscapedPath() != "/"+strings.Join(parts, "/") {
		return fmt.Errorf("pull request URL %q is not canonical", value)
	}
	return nil
}

func validateTimestamp(value string) error {
	if _, err := time.Parse(time.RFC3339, value); err != nil {
		return fmt.Errorf("must be an RFC3339 timestamp: %w", err)
	}
	return nil
}

func validateDocumentPath(value string) error {
	if err := validateSourcePath(value); err != nil {
		return err
	}
	if documentFormat(value) == "" {
		return fmt.Errorf("preview document %q must be HTML or Markdown", value)
	}
	return nil
}

func validateSourcePath(value string) error {
	if value == "" || !utf8.ValidString(value) || strings.Contains(value, `\`) || strings.HasPrefix(value, "/") {
		return fmt.Errorf("unsafe preview source-relative path %q", value)
	}
	if path.Clean(value) != value || value == "." || value == ".." || strings.HasPrefix(value, "../") {
		return fmt.Errorf("non-canonical preview source-relative path %q", value)
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return fmt.Errorf("unsafe preview source-relative path %q", value)
		}
	}
	if strings.Split(value, "/")[0] == "_previews" {
		return fmt.Errorf("preview source path %q uses a reserved namespace", value)
	}
	return nil
}

func documentFormat(value string) string {
	switch strings.ToLower(path.Ext(value)) {
	case ".html", ".htm":
		return "html"
	case ".md":
		return "markdown"
	default:
		return ""
	}
}

func validSiteID(siteID string) bool {
	return siteIDPattern.MatchString(siteID)
}

func encodeJSON(value any) ([]byte, error) {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}

// decodeStrict rejects trailing JSON values but, per the reader rules, ignores
// unknown fields.
func decodeStrict(data []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("trailing JSON value")
		}
		return err
	}
	return nil
}

func sortDocuments(documents []Document) {
	sort.Slice(documents, func(i, j int) bool { return documents[i].Path < documents[j].Path })
}

func encodePath(value string) string {
	segments := strings.Split(value, "/")
	for i, segment := range segments {
		segments[i] = encodeSegment(segment)
	}
	return strings.Join(segments, "/")
}

func encodeSegment(value string) string {
	const hex = "0123456789ABCDEF"
	var encoded strings.Builder
	for _, current := range []byte(value) {
		if (current >= 'a' && current <= 'z') || (current >= 'A' && current <= 'Z') || (current >= '0' && current <= '9') || strings.ContainsRune("-_.!~*'()", rune(current)) {
			encoded.WriteByte(current)
			continue
		}
		encoded.WriteByte('%')
		encoded.WriteByte(hex[current>>4])
		encoded.WriteByte(hex[current&0x0f])
	}
	return encoded.String()
}
