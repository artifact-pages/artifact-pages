package registry

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestBuildSortsSitesAndEmitsStableJSON(t *testing.T) {
	input := []byte(`schemaVersion: 1
sites:
  zeta:
    name: Zeta
    repository: acme/zeta
    sourcePath: docs/reports
  alpha:
    name: Alpha & Ops
    repository: acme/alpha
    sourcePath: .
`)
	got, projection, err := Build(input)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if len(projection.Sites) != 2 || projection.Sites[0].ID != "alpha" || projection.Sites[1].ID != "zeta" {
		t.Fatalf("projection site order = %#v, want alpha then zeta", projection.Sites)
	}
	want := "{\n  \"schemaVersion\": 1,\n  \"sites\": [\n    {\n      \"id\": \"alpha\",\n      \"name\": \"Alpha & Ops\",\n      \"repository\": \"acme/alpha\",\n      \"sourcePath\": \".\"\n    },\n    {\n      \"id\": \"zeta\",\n      \"name\": \"Zeta\",\n      \"repository\": \"acme/zeta\",\n      \"sourcePath\": \"docs/reports\"\n    }\n  ]\n}\n"
	if string(got) != want {
		t.Fatalf("projection JSON =\n%s\nwant\n%s", got, want)
	}
	reordered := []byte(`schemaVersion: 1
sites:
  alpha:
    name: Alpha & Ops
    repository: acme/alpha
    sourcePath: .
  zeta:
    name: Zeta
    repository: acme/zeta
    sourcePath: docs/reports
`)
	second, _, err := Build(reordered)
	if err != nil || string(second) != string(got) {
		t.Fatalf("Build() should be stable for same mapping: err=%v\n%s", err, second)
	}
}

func TestBuildAllowsEmptyMapping(t *testing.T) {
	got, projection, err := Build([]byte("schemaVersion: 1\nsites: {}\n"))
	if err != nil {
		t.Fatalf("Build(empty) error = %v", err)
	}
	if projection.Sites == nil || len(projection.Sites) != 0 {
		t.Fatalf("empty projection sites = %#v, want a non-nil empty slice", projection.Sites)
	}
	if !strings.Contains(string(got), `"sites": []`) {
		t.Fatalf("empty registry JSON = %s, want sites: []", got)
	}
}

func TestParseYAMLAcceptsGitHubRepositoryNameCharacters(t *testing.T) {
	for _, name := range []string{".github", "platform.config", "123project"} {
		t.Run(name, func(t *testing.T) {
			contents := []byte("schemaVersion: 1\nsites:\n  docs:\n    name: Site\n    repository: Acme/" + name + "\n    sourcePath: docs\n")
			projection, err := ParseYAML(contents)
			if err != nil {
				t.Fatalf("ParseYAML() error = %v, want repository name %q accepted", err, name)
			}
			if got := projection.Sites[0].Repository; got != "Acme/"+name {
				t.Fatalf("repository = %q, want original owner/repository spelling", got)
			}
		})
	}
}

func TestParseYAMLRejectsInvalidManifest(t *testing.T) {
	validSite := "    name: Site\n    repository: acme/repo\n    sourcePath: docs\n"
	tests := []struct {
		name string
		body string
		want string
	}{
		{"wrong version", "schemaVersion: 2\nsites: {}\n", "schemaVersion"},
		{"missing sites", "schemaVersion: 1\n", "sites must be a mapping"},
		{"sites is a sequence", "schemaVersion: 1\nsites: []\n", "sites must be a mapping"},
		{"unknown root field", "schemaVersion: 1\nextra: true\nsites: {}\n", "field extra not found"},
		{"duplicate root field", "schemaVersion: 1\nschemaVersion: 1\nsites: {}\n", "already defined"},
		{"multiple documents", "schemaVersion: 1\nsites: {}\n---\nschemaVersion: 1\nsites: {}\n", "exactly one YAML document"},
		{"schema version wrong type", "schemaVersion: 'one'\nsites: {}\n", "schemaVersion must be an integer"},
		{"unknown site field", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n    sourcePath: docs\n    extra: additional\n", "field extra not found"},
		{"duplicate site field", "schemaVersion: 1\nsites:\n  sre:\n    name: First\n    name: Second\n    repository: acme/repo\n    sourcePath: docs\n", "already defined"},
		{"duplicate site id", "schemaVersion: 1\nsites:\n  sre:\n    name: First\n    repository: acme/repo\n    sourcePath: docs\n  sre:\n    name: Second\n    repository: acme/other\n    sourcePath: docs\n", "already defined"},
		{"missing name", "schemaVersion: 1\nsites:\n  sre:\n    repository: acme/repo\n    sourcePath: docs\n", "name must not be blank"},
		{"missing repository", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    sourcePath: docs\n", "owner/repository"},
		{"missing source path", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n", "sourcePath"},
		{"site field wrong type", "schemaVersion: 1\nsites:\n  sre:\n    name: 42\n    repository: acme/repo\n    sourcePath: docs\n", "must be a string"},
		{"invalid site id", "schemaVersion: 1\nsites:\n  SRE:\n" + validSite, "invalid site ID"},
		{"reserved site id", "schemaVersion: 1\nsites:\n  assets:\n" + validSite, "reserved"},
		{"blank site name", "schemaVersion: 1\nsites:\n  sre:\n    name: '  '\n    repository: acme/repo\n    sourcePath: docs\n", "name must not be blank"},
		{"repository URL", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: https://github.com/acme/repo\n    sourcePath: docs\n", "owner/repository"},
		{"repository clone URL", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo.git\n    sourcePath: docs\n", "owner/repository"},
		{"repository clone suffix is case insensitive", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo.GIT\n    sourcePath: docs\n", "owner/repository"},
		{"repository component too long", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/" + strings.Repeat("a", 101) + "\n    sourcePath: docs\n", "owner/repository"},
		{"repository component traversal", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/..\n    sourcePath: docs\n", "owner/repository"},
		{"repository component contains slash", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo/child\n    sourcePath: docs\n", "owner/repository"},
		{"repository component contains unsafe character", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo?name\n    sourcePath: docs\n", "owner/repository"},
		{"source path blank", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n    sourcePath: '  '\n", "sourcePath"},
		{"source path absolute", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n    sourcePath: /docs\n", "repository-relative"},
		{"source path backslash", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n    sourcePath: docs\\reports\n", "repository-relative"},
		{"source path traversal", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n    sourcePath: ../outside\n", "traversal"},
		{"source path noncanonical", "schemaVersion: 1\nsites:\n  sre:\n    name: Site\n    repository: acme/repo\n    sourcePath: docs//reports\n", "traversal"},
		{"duplicate source pair", "schemaVersion: 1\nsites:\n  alpha:\n    name: Alpha\n    repository: acme/repo\n    sourcePath: docs\n  beta:\n    name: Beta\n    repository: acme/repo\n    sourcePath: docs\n", "same repository and sourcePath"},
		{"duplicate source pair with repository case difference", "schemaVersion: 1\nsites:\n  alpha:\n    name: Alpha\n    repository: Acme/Repo\n    sourcePath: docs\n  beta:\n    name: Beta\n    repository: acme/repo\n    sourcePath: docs\n", "same repository and sourcePath"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ParseYAML([]byte(test.body))
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("ParseYAML() error = %v, want substring %q", err, test.want)
			}
		})
	}
}

func TestDecodeProjectionRejectsMalformedRuntimeJSON(t *testing.T) {
	tests := []struct {
		name string
		json string
		want string
	}{
		{"unknown field", `{"schemaVersion":1,"sites":[],"extra":true}`, "unknown field"},
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
