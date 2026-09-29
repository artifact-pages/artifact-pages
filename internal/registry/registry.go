package registry

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/tasuku43/git-artifact-pages/internal/githubrepo"
)

const SchemaVersion = 1

var (
	siteIDPattern     = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
)

// Site is the sole human-maintained record for one registered source tree.
type Site struct {
	Name        string `yaml:"name" json:"name"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
	Repository  string `yaml:"repository" json:"repository"`
	SourcePath  string `yaml:"sourcePath" json:"sourcePath"`
}

// Projection is the deterministic runtime form consumed by browsers and
// satellite publishers. Sites is always a non-nil slice when serialized.
type Projection struct {
	SchemaVersion int     `json:"schemaVersion"`
	Sites         []Entry `json:"sites"`
}

// Entry is one site in the deployed array representation.
type Entry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Repository  string `json:"repository"`
	SourcePath  string `json:"sourcePath"`
}

// ProjectSites turns the site records from a validated unified deployment
// config into the sorted runtime representation. A nil map means the config
// omitted sites; an empty non-nil map is an explicit empty desired registry.
func ProjectSites(sites map[string]Site) (Projection, error) {
	if sites == nil {
		return Projection{}, errors.New("sites must be a mapping (use sites: {} for an empty registry)")
	}
	ids := make([]string, 0, len(sites))
	for id := range sites {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	projection := Projection{SchemaVersion: SchemaVersion, Sites: make([]Entry, 0, len(ids))}
	seenSource := make(map[string]string, len(ids))
	for _, id := range ids {
		site := sites[id]
		if err := validateSiteID(id); err != nil {
			return Projection{}, err
		}
		if strings.TrimSpace(site.Name) == "" {
			return Projection{}, fmt.Errorf("site %q name must not be blank", id)
		}
		if !validRepository(site.Repository) {
			return Projection{}, fmt.Errorf("site %q repository must be exactly owner/repository", id)
		}
		if err := validateSourcePath(site.SourcePath); err != nil {
			return Projection{}, fmt.Errorf("site %q sourcePath: %w", id, err)
		}
		pair := sourcePairKey(site.Repository, site.SourcePath)
		if previous, exists := seenSource[pair]; exists {
			return Projection{}, fmt.Errorf("sites %q and %q use the same repository and sourcePath", previous, id)
		}
		seenSource[pair] = id
		description := site.Description
		if strings.TrimSpace(description) == "" {
			description = ""
		}
		projection.Sites = append(projection.Sites, Entry{
			ID: id, Name: site.Name, Description: description, Repository: site.Repository, SourcePath: site.SourcePath,
		})
	}
	return projection, nil
}

// Encode emits byte-stable indented JSON, independent of YAML mapping order.
func Encode(projection Projection) ([]byte, error) {
	if projection.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("schemaVersion must be %d", SchemaVersion)
	}
	if projection.Sites == nil {
		projection.Sites = []Entry{}
	}
	projection.Sites = append([]Entry(nil), projection.Sites...)
	if projection.Sites == nil {
		projection.Sites = []Entry{}
	}
	sort.Slice(projection.Sites, func(i, j int) bool { return projection.Sites[i].ID < projection.Sites[j].ID })
	if err := validateEntries(projection.Sites, true); err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(projection); err != nil {
		return nil, fmt.Errorf("encode sites.json: %w", err)
	}
	return buffer.Bytes(), nil
}

func validateSiteID(id string) error {
	if !siteIDPattern.MatchString(id) {
		return fmt.Errorf("invalid site ID %q: expected lowercase letters/digits separated by single hyphens", id)
	}
	if id == "assets" {
		return fmt.Errorf("site ID %q is reserved by the application plane", id)
	}
	return nil
}

// ValidateSiteID checks a selected site identifier using the registry's
// canonical identifier rules. Commands use it before resolving a deployment
// target so invalid input is reported as an argument error.
func ValidateSiteID(id string) error {
	return validateSiteID(id)
}

func validRepository(repository string) bool {
	if !repositoryPattern.MatchString(repository) {
		return false
	}
	parts := strings.SplitN(repository, "/", 2)
	return githubrepo.ValidRepositoryName(parts[1])
}

func sourcePairKey(repository, sourcePath string) string {
	// Publisher eligibility compares repository locators case-insensitively, so
	// registry uniqueness must use the same repository identity semantics.
	return strings.ToLower(repository) + "\x00" + sourcePath
}

func validateSourcePath(sourcePath string) error {
	if sourcePath == "" || strings.TrimSpace(sourcePath) != sourcePath {
		return errors.New("must not be blank or have leading/trailing whitespace")
	}
	if sourcePath == "." {
		return nil
	}
	if strings.Contains(sourcePath, `\`) || strings.HasPrefix(sourcePath, "/") || path.IsAbs(sourcePath) {
		return errors.New("must be a canonical repository-relative POSIX path")
	}
	cleaned := path.Clean(sourcePath)
	if cleaned != sourcePath || cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return errors.New("must not contain traversal or non-canonical path segments")
	}
	return nil
}

// DecodeProjection validates the public JSON representation and requires its
// array to be sorted and unique, matching the deterministic writer contract.
func DecodeProjection(contents []byte) (Projection, error) {
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var projection Projection
	if err := decoder.Decode(&projection); err != nil {
		return Projection{}, fmt.Errorf("decode sites.json: %w", err)
	}
	if projection.SchemaVersion != SchemaVersion || projection.Sites == nil {
		return Projection{}, errors.New("sites.json has an unsupported schema or a non-array sites field")
	}
	if err := validateEntries(projection.Sites, true); err != nil {
		return Projection{}, err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Projection{}, errors.New("decode sites.json: multiple JSON values are not allowed")
	}
	return projection, nil
}

func validateEntries(entries []Entry, requireSorted bool) error {
	seenSource := make(map[string]string, len(entries))
	previousID := ""
	for _, entry := range entries {
		if err := validateSiteID(entry.ID); err != nil {
			return err
		}
		if previousID != "" && entry.ID <= previousID {
			message := "sites must have unique IDs"
			if requireSorted {
				message = "sites must be uniquely sorted by ID"
			}
			return errors.New(message)
		}
		previousID = entry.ID
		if strings.TrimSpace(entry.Name) == "" {
			return fmt.Errorf("site %q name must not be blank", entry.ID)
		}
		if !validRepository(entry.Repository) {
			return fmt.Errorf("site %q repository must be exactly owner/repository", entry.ID)
		}
		if err := validateSourcePath(entry.SourcePath); err != nil {
			return fmt.Errorf("site %q sourcePath: %w", entry.ID, err)
		}
		pair := sourcePairKey(entry.Repository, entry.SourcePath)
		if previous, exists := seenSource[pair]; exists {
			return fmt.Errorf("sites %q and %q use the same repository and sourcePath", previous, entry.ID)
		}
		seenSource[pair] = entry.ID
	}
	return nil
}
