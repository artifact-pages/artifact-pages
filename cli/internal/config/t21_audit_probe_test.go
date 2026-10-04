//go:build t21audit

package config

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestT21RemoteConfigCallProfile is an explicit, local HTTP-server probe of
// the current resolver request shape; it makes no GitHub requests.
func TestT21RemoteConfigCallProfile(t *testing.T) {
	const sha = "0123456789abcdef0123456789abcdef01234567"
	configBytes := []byte("schemaVersion: 1\nprovider: local\nlocal:\n  root: .local/storage\n")
	for _, test := range []struct {
		name    string
		locator string
		want    int
	}{
		{name: "default branch", locator: "github://acme/admin", want: 3},
		{name: "named branch", locator: "github://acme/admin?ref=main", want: 2},
		{name: "pinned SHA", locator: "github://acme/admin?ref=" + sha, want: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var paths []string
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				paths = append(paths, request.URL.Path+"?"+request.URL.RawQuery)
				switch request.URL.Path {
				case "/repos/acme/admin":
					_, _ = writer.Write([]byte(`{"default_branch":"main"}`))
				case "/repos/acme/admin/commits/main":
					_, _ = fmt.Fprintf(writer, `{"sha":%q}`, sha)
				case "/repos/acme/admin/contents/artifact-pages.yaml":
					_ = json.NewEncoder(writer).Encode(githubContent{
						Type: "file", Encoding: "base64", Content: base64.StdEncoding.EncodeToString(configBytes), SHA: "file-sha",
					})
				default:
					writer.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			resolver := Resolver{WorkingDir: t.TempDir(), GitHubAPIBaseURL: server.URL}
			resolved, err := resolver.Resolve(t.Context(), test.locator)
			if err != nil {
				t.Fatalf("Resolve: %v", err)
			}
			t.Logf("requests=%d paths=%v resolvedSHA=%s", len(paths), paths, resolved.CommitSHA)
			if len(paths) != test.want {
				t.Fatalf("request count=%d, want %d", len(paths), test.want)
			}
		})
	}
}
