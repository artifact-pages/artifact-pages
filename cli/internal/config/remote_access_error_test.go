package config

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRemoteConfigAccessErrors(t *testing.T) {
	const secret = "ghp_secretvalue123"
	const sha = "0123456789abcdef0123456789abcdef01234567"
	const locator = "github://acme/admin/artifact-pages.yaml"
	tests := []struct {
		name    string
		token   string
		locator string
		handler func(http.ResponseWriter, *http.Request)
		want    []string
	}{
		{"no token 404", "", locator, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) },
			[]string{"cannot read deployment config " + locator, "may be private", "no token was provided", "GITHUB_TOKEN or GH_TOKEN", "github-token", "contents:read on acme/admin"}},
		{"token 404", secret, locator, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(404) },
			[]string{"cannot read deployment config " + locator, "private repositories the token cannot access", "contents:read on acme/admin"}},
		{"401", secret, locator, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) },
			[]string{"cannot read deployment config " + locator, "rejected the token (HTTP 401)", "invalid or expired"}},
		{"403 rate limited", secret, locator, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.WriteHeader(403)
		}, []string{"HTTP 403", "rate limit is exhausted"}},
		{"403 permission", secret, locator, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(403) },
			[]string{"HTTP 403", "lacks permission", "contents:read on acme/admin"}},
		{"contents 404 after metadata", secret, locator, func(w http.ResponseWriter, r *http.Request) {
			if strings.Contains(r.URL.Path, "/contents/") {
				w.WriteHeader(404)
				return
			}
			if strings.Contains(r.URL.Path, "/commits/") {
				_, _ = w.Write([]byte(`{"sha":"` + sha + `"}`))
				return
			}
			_, _ = w.Write([]byte(`{"default_branch":"main"}`))
		}, []string{"cannot read deployment config " + locator, "path or ref does not exist in acme/admin"}},
		{"ref 401", secret, locator + "?ref=v1", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(401) },
			[]string{"cannot read deployment config " + locator + "?ref=v1", "rejected the token"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(tt.handler))
			defer server.Close()
			env := map[string]string{}
			if tt.token != "" {
				env["GITHUB_TOKEN"] = tt.token
			}
			resolver := Resolver{WorkingDir: t.TempDir(), GitHubAPIBaseURL: server.URL, Getenv: func(k string) string { return env[k] }}
			_, err := resolver.Resolve(t.Context(), tt.locator)
			if err == nil {
				t.Fatal("Resolve succeeded, want error")
			}
			for _, want := range tt.want {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q missing %q", err, want)
				}
			}
			if strings.Contains(err.Error(), secret) {
				t.Errorf("error contains the token: %q", err)
			}
			t.Log(err)
		})
	}
}
