package preview

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

const pullRequestTestSHA = "0123456789abcdef0123456789abcdef01234567"

func TestPullRequestResolverAcceptsExplicitNumberOrCanonicalURL(t *testing.T) {
	var requests int
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests++
		if request.Method != http.MethodGet || request.URL.Path != "/repos/acme/project/pulls/42" {
			t.Errorf("request = %s %s, want GET /repos/acme/project/pulls/42", request.Method, request.URL.Path)
		}
		if got := request.Header.Get("Accept"); got != "application/vnd.github+json" {
			t.Errorf("Accept = %q", got)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer test-token" {
			t.Errorf("Authorization = %q", got)
		}
		writer.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(writer, `{"number":42,"html_url":"https://github.com/acme/project/pull/42","base":{"repo":{"full_name":"acme/project"}},"head":{"sha":%q,"repo":{"full_name":"acme/project"}}}`, pullRequestTestSHA)
	}))
	defer server.Close()
	resolver := PullRequestResolver{APIBaseURL: server.URL, Token: "test-token"}
	for _, reference := range []string{"42", "https://github.com/acme/project/pull/42"} {
		info, err := resolver.Resolve(context.Background(), "acme/project", reference)
		if err != nil {
			t.Fatalf("Resolve(%q) error = %v", reference, err)
		}
		if info.Number != 42 || info.URL != "https://github.com/acme/project/pull/42" || info.BaseRepo != "acme/project" || info.HeadRepo != "acme/project" || info.HeadSHA != pullRequestTestSHA {
			t.Fatalf("Resolve(%q) = %+v", reference, info)
		}
	}
	if requests != 2 {
		t.Fatalf("GitHub API requests = %d, want 2", requests)
	}
}

func TestPullRequestResolverRejectsWrongRepositoryForkAndMalformedResponses(t *testing.T) {
	t.Run("wrong URL repository", func(t *testing.T) {
		resolver := PullRequestResolver{}
		if _, err := resolver.Resolve(context.Background(), "acme/project", "https://github.com/fork/project/pull/42"); err == nil {
			t.Fatal("Resolve accepted a PR URL from another repository")
		}
	})
	t.Run("fork origin", func(t *testing.T) {
		server := pullRequestResponseServer(`{"number":42,"html_url":"https://github.com/acme/project/pull/42","base":{"repo":{"full_name":"acme/project"}},"head":{"sha":"` + pullRequestTestSHA + `","repo":{"full_name":"someone/project"}}}`)
		defer server.Close()
		if _, err := (PullRequestResolver{APIBaseURL: server.URL}).Resolve(context.Background(), "acme/project", "42"); err == nil {
			t.Fatal("Resolve accepted a fork-origin PR")
		}
	})
	t.Run("wrong base repository", func(t *testing.T) {
		server := pullRequestResponseServer(`{"number":42,"base":{"repo":{"full_name":"someone/project"}},"head":{"sha":"` + pullRequestTestSHA + `","repo":{"full_name":"acme/project"}}}`)
		defer server.Close()
		if _, err := (PullRequestResolver{APIBaseURL: server.URL}).Resolve(context.Background(), "acme/project", "42"); err == nil {
			t.Fatal("Resolve accepted a PR targeting another repository")
		}
	})
	t.Run("missing head repository", func(t *testing.T) {
		server := pullRequestResponseServer(`{"number":42,"base":{"repo":{"full_name":"acme/project"}},"head":{"sha":"` + pullRequestTestSHA + `","repo":null}}`)
		defer server.Close()
		if _, err := (PullRequestResolver{APIBaseURL: server.URL}).Resolve(context.Background(), "acme/project", "42"); err == nil {
			t.Fatal("Resolve accepted a PR with a missing head repository")
		}
	})
	t.Run("wrong response number", func(t *testing.T) {
		server := pullRequestResponseServer(`{"number":43,"base":{"repo":{"full_name":"acme/project"}},"head":{"sha":"` + pullRequestTestSHA + `","repo":{"full_name":"acme/project"}}}`)
		defer server.Close()
		if _, err := (PullRequestResolver{APIBaseURL: server.URL}).Resolve(context.Background(), "acme/project", "42"); err == nil {
			t.Fatal("Resolve accepted a mismatched API response")
		}
	})
}

func TestPullRequestResolverRejectsNonCanonicalReferencesAndAPIErrors(t *testing.T) {
	for _, reference := range []string{"", "0", "042", "+42", "https://github.com/acme/project/pull/42?tab=files", "https://github.com/acme/project/pull/%34%32"} {
		if _, err := (PullRequestResolver{}).Resolve(context.Background(), "acme/project", reference); err == nil {
			t.Errorf("Resolve accepted non-canonical reference %q", reference)
		}
	}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusForbidden)
		_, _ = writer.Write([]byte("do not include this response body"))
	}))
	defer server.Close()
	_, err := (PullRequestResolver{APIBaseURL: server.URL}).Resolve(context.Background(), "acme/project", "42")
	if err == nil || err.Error() != "GitHub pull request lookup returned HTTP 403" {
		t.Fatalf("Resolve() error = %v, want bounded API status error", err)
	}
}

func pullRequestResponseServer(body string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(body))
	}))
}
