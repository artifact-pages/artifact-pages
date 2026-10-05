package registry

import (
	"encoding/json"
	"errors"
	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
	"strings"
	"testing"
)

func TestProjectSitesSortsAndEncodeEmitsStableJSON(t *testing.T) {
	sites := map[string]Site{
		"zeta":  {Name: "Zeta", Repository: "acme/zeta", SourcePath: "docs/reports"},
		"alpha": {Name: "Alpha & Ops", Description: "Operations and incidents", Repository: "acme/alpha", SourcePath: "."},
	}
	projection, err := ProjectSites(sites)
	if err != nil {
		t.Fatalf("ProjectSites() error = %v", err)
	}
	if len(projection.Sites) != 2 || projection.Sites[0].ID != "alpha" || projection.Sites[1].ID != "zeta" {
		t.Fatalf("projection site order = %#v, want alpha then zeta", projection.Sites)
	}
	got, err := Encode(projection)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	want := "{\n  \"schemaVersion\": 1,\n  \"sites\": [\n    {\n      \"id\": \"alpha\",\n      \"name\": \"Alpha & Ops\",\n      \"description\": \"Operations and incidents\",\n      \"repository\": \"acme/alpha\",\n      \"sourcePath\": \".\"\n    },\n    {\n      \"id\": \"zeta\",\n      \"name\": \"Zeta\",\n      \"repository\": \"acme/zeta\",\n      \"sourcePath\": \"docs/reports\"\n    }\n  ]\n}\n"
	if string(got) != want {
		t.Fatalf("projection JSON =\n%s\nwant\n%s", got, want)
	}
	second, err := Encode(projection)
	if err != nil || string(second) != string(got) {
		t.Fatalf("Encode() should be stable for same projection: err=%v\n%s", err, second)
	}
}

func TestProjectSitesAllowsExplicitEmptyMapping(t *testing.T) {
	projection, err := ProjectSites(map[string]Site{})
	if err != nil {
		t.Fatalf("ProjectSites(empty) error = %v", err)
	}
	if projection.Sites == nil || len(projection.Sites) != 0 {
		t.Fatalf("empty projection sites = %#v, want a non-nil empty slice", projection.Sites)
	}
	got, err := Encode(projection)
	if err != nil {
		t.Fatalf("Encode(empty) error = %v", err)
	}
	if !strings.Contains(string(got), `"sites": []`) {
		t.Fatalf("empty registry JSON = %s, want sites: []", got)
	}
}

func TestProjectSitesAcceptsGitHubRepositoryNameCharacters(t *testing.T) {
	for _, name := range []string{".github", "platform.config", "123project"} {
		t.Run(name, func(t *testing.T) {
			projection, err := ProjectSites(map[string]Site{"docs": {
				Name: "Site", Repository: "Acme/" + name, SourcePath: "docs",
			}})
			if err != nil {
				t.Fatalf("ProjectSites() error = %v, want repository name %q accepted", err, name)
			}
			if got := projection.Sites[0].Repository; got != "Acme/"+name {
				t.Fatalf("repository = %q, want original owner/repository spelling", got)
			}
		})
	}
}

func TestProjectSitesRejectsInvalidSites(t *testing.T) {
	tests := []struct {
		name   string
		siteID string
		site   Site
		other  map[string]Site
		want   string
	}{
		{"invalid site ID", "SRE", Site{Name: "Site", Repository: "acme/repo", SourcePath: "docs"}, nil, "invalid site ID"},
		{"reserved site ID", "assets", Site{Name: "Site", Repository: "acme/repo", SourcePath: "docs"}, nil, "reserved"},
		{"missing name", "sre", Site{Repository: "acme/repo", SourcePath: "docs"}, nil, "name must not be blank"},
		{"missing repository", "sre", Site{Name: "Site", SourcePath: "docs"}, nil, "owner/repository"},
		{"missing source path", "sre", Site{Name: "Site", Repository: "acme/repo"}, nil, "sourcePath"},
		{"blank site name", "sre", Site{Name: "  ", Repository: "acme/repo", SourcePath: "docs"}, nil, "name must not be blank"},
		{"repository URL", "sre", Site{Name: "Site", Repository: "https://github.com/acme/repo", SourcePath: "docs"}, nil, "owner/repository"},
		{"repository clone URL", "sre", Site{Name: "Site", Repository: "acme/repo.git", SourcePath: "docs"}, nil, "owner/repository"},
		{"source path blank", "sre", Site{Name: "Site", Repository: "acme/repo", SourcePath: "  "}, nil, "sourcePath"},
		{"source path absolute", "sre", Site{Name: "Site", Repository: "acme/repo", SourcePath: "/docs"}, nil, "repository-relative"},
		{"source path traversal", "sre", Site{Name: "Site", Repository: "acme/repo", SourcePath: "../outside"}, nil, "traversal"},
		{"duplicate source pair", "alpha", Site{Name: "Alpha", Repository: "acme/repo", SourcePath: "docs"}, map[string]Site{"beta": {Name: "Beta", Repository: "acme/repo", SourcePath: "docs"}}, "same repository and sourcePath"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			sites := map[string]Site{test.siteID: test.site}
			for id, site := range test.other {
				sites[id] = site
			}
			_, err := ProjectSites(sites)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("ProjectSites() error = %v, want substring %q", err, test.want)
			}
		})
	}
	if _, err := ProjectSites(nil); err == nil || !strings.Contains(err.Error(), "sites must be a mapping") {
		t.Fatalf("ProjectSites(nil) error = %v, want missing-sites error", err)
	}
}

func TestDecodeProjectionRejectsMalformedRuntimeJSON(t *testing.T) {
	tests := []struct {
		name string
		json string
		want string
	}{
		{"duplicate ID", `{"schemaVersion":1,"sites":[{"id":"sre","name":"One","repository":"acme/repo","sourcePath":"docs"},{"id":"sre","name":"Two","repository":"acme/other","sourcePath":"docs"}]}`, "sorted by ID"},
		{"unsorted IDs", `{"schemaVersion":1,"sites":[{"id":"zeta","name":"Zeta","repository":"acme/zeta","sourcePath":"docs"},{"id":"alpha","name":"Alpha","repository":"acme/alpha","sourcePath":"docs"}]}`, "sorted by ID"},
		{"duplicate source pair with repository case difference", `{"schemaVersion":1,"sites":[{"id":"alpha","name":"Alpha","repository":"Acme/Repo","sourcePath":"docs"},{"id":"beta","name":"Beta","repository":"acme/repo","sourcePath":"docs"}]}`, "same repository and sourcePath"},
		{"multiple values", `{"schemaVersion":1,"sites":[]} {}`, "multiple JSON values"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := DecodeProjection([]byte(test.json))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("DecodeProjection() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestDecodeProjectionReaderRules(t *testing.T) {
	projection, err := DecodeProjection([]byte(`{"schemaVersion":1,"future":{"a":1},"sites":[{"id":"sre","name":"SRE","repository":"acme/repo","sourcePath":"docs","futureField":true}]}`))
	if err != nil || len(projection.Sites) != 1 {
		t.Fatalf("unknown fields must be ignored: %+v, %v", projection, err)
	}
	_, err = DecodeProjection([]byte(`{"schemaVersion":2,"sites":"different shape"}`))
	var unsupported *compat.UnsupportedSchemaError
	if !errors.As(err, &unsupported) || unsupported.Found != 2 || !strings.Contains(err.Error(), "Upgrade the CLI") {
		t.Fatalf("DecodeProjection(v2) error = %v, want an unsupported-schema error naming the upgrade", err)
	}
}

func TestEncodeSortsAndValidatesProjection(t *testing.T) {
	input := Projection{SchemaVersion: 1, Sites: []Entry{
		{ID: "zeta", Name: "Zeta", Repository: "acme/zeta", SourcePath: "docs"},
		{ID: "alpha", Name: "Alpha", Repository: "acme/alpha", SourcePath: "."},
	}}
	encoded, err := Encode(input)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	decoded, err := DecodeProjection(encoded)
	if err != nil {
		t.Fatalf("DecodeProjection() error = %v", err)
	}
	if decoded.Sites[0].ID != "alpha" || decoded.Sites[1].ID != "zeta" {
		t.Fatalf("encoded order = %#v, want sorted IDs", decoded.Sites)
	}
	var generic map[string]any
	if err := json.Unmarshal(encoded, &generic); err != nil {
		t.Fatalf("output is not JSON: %v", err)
	}
}
