package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func responseFor(request *http.Request, status int, body string, headers map[string]string) *http.Response {
	responseHeaders := make(http.Header)
	for key, value := range headers {
		responseHeaders.Set(key, value)
	}
	return &http.Response{
		StatusCode: status, Header: responseHeaders, Body: io.NopCloser(strings.NewReader(body)), Request: request,
	}
}

func githubTestConfig(roundTrip roundTripFunc) githubEnrichmentConfig {
	config := defaultGitHubEnrichmentConfig()
	config.client = &http.Client{Transport: roundTrip}
	config.baseURL = "https://api.github.test"
	config.totalTimeout = time.Second
	config.requestTimeout = 200 * time.Millisecond
	return config
}

func githubTestUpdate(sha, name string) artifactGitUpdate {
	return artifactGitUpdate{
		updatedAt: time.Unix(1, 0).UTC(), lastCommitter: "GitHub", commitSHA: sha,
		lastAuthor: &ArtifactAuthor{Name: name, CommitSHA: sha},
	}
}

func githubTestMetadata(sourceURL, origin string) gitMetadata {
	return gitMetadata{repositoryURL: sourceURL, originRemote: origin}
}

func githubResponse(sha, login, avatar string) string {
	return fmt.Sprintf(`{"sha":%q,"author":{"login":%q,"avatar_url":%q,"email":"private@example.invalid"},"committer":{"login":"wrong"},"commit":{"author":{"email":"nested@example.invalid"}}}`, sha, login, avatar)
}

func TestGitHubCommitLookupUsesTopLevelAuthorAndPinnedRequestContract(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "primary-token")
	t.Setenv("GH_TOKEN", "fallback-token")
	sha := strings.Repeat("a", 40)
	called := 0
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		called++
		if request.Method != http.MethodGet || request.URL.Path != "/repos/acme/repo/commits/"+sha || request.URL.Query().Get("per_page") != "1" {
			t.Errorf("request = %s %s, want bounded commit endpoint", request.Method, request.URL.String())
		}
		if request.Header.Get("Authorization") != "Bearer primary-token" {
			t.Errorf("Authorization = %q, want GITHUB_TOKEN precedence", request.Header.Get("Authorization"))
		}
		if request.Header.Get("Accept") != "application/vnd.github+json" || request.Header.Get("X-GitHub-Api-Version") != "2026-03-10" {
			t.Errorf("request headers = %#v", request.Header)
		}
		return responseFor(request, http.StatusOK, githubResponse(sha, "octocat", "https://avatars.githubusercontent.com/u/1?v=4"), nil), nil
	})
	updates := map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Alice Example"), "two.md": githubTestUpdate(sha, "Alice Example")}
	warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:ACME/REPO.git"), updates, nil, config)
	if err != nil || warning != "" {
		t.Fatalf("enrichGitAuthors() = warning %q, error %v", warning, err)
	}
	if called != 1 {
		t.Fatalf("commit API requests = %d, want one deduplicated request", called)
	}
	for path, update := range updates {
		if update.lastAuthor == nil || update.lastAuthor.Name != "Alice Example" || update.lastAuthor.CommitSHA != sha || update.lastAuthor.GitHub == nil || update.lastAuthor.GitHub.Login != "octocat" || update.lastAuthor.GitHub.AvatarURL != "https://avatars.githubusercontent.com/u/1?v=4" {
			t.Errorf("%s attribution = %+v", path, update.lastAuthor)
		}
		encoded, _ := json.Marshal(update.lastAuthor)
		if strings.Contains(string(encoded), "email") || strings.Contains(string(encoded), "token") || strings.Contains(string(encoded), "nested@example.invalid") {
			t.Errorf("public author object includes private data: %s", encoded)
		}
	}
}

func TestBuildEnrichmentUsesCommitSHAForOrdinaryAndBothNoreplyEmailForms(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "workflow-token")
	root := initializeGitRepository(t)
	runGit(t, root, "remote", "add", "origin", "git@github.com:acme/repo.git")
	firstTime := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	writeFixtureFile(t, root, "artifacts/ordinary.html", "<h1>Ordinary</h1>")
	commitWithGitDates(t, root, "ordinary identity", "Alice Example", "alice@example.invalid", "GitHub", "web-flow@example.invalid", firstTime, firstTime)
	modernTime := firstTime.Add(time.Hour)
	writeFixtureFile(t, root, "artifacts/modern-noreply.html", "<h1>Modern noreply</h1>")
	commitWithGitDates(t, root, "modern noreply identity", "Octocat Author", "583231+octocat@users.noreply.github.com", "GitHub", "web-flow@example.invalid", modernTime, modernTime)
	legacyTime := firstTime.Add(2 * time.Hour)
	writeFixtureFile(t, root, "artifacts/legacy-noreply.html", "<h1>Legacy noreply</h1>")
	commitWithGitDates(t, root, "legacy noreply identity", "Legacy Octocat", "octocat@users.noreply.github.com", "GitHub", "web-flow@example.invalid", legacyTime, legacyTime)

	requests := 0
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		requests++
		if request.Header.Get("Authorization") != "Bearer workflow-token" {
			t.Errorf("GitHub token source = %q, want GH_TOKEN fallback", request.Header.Get("Authorization"))
		}
		sha := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
		return responseFor(request, 200, githubResponse(sha, "octocat", "https://avatars.githubusercontent.com/u/583231?v=4"), nil), nil
	})
	index := builtIndexFrom(t, root, "artifacts", BuildOptions{
		RepositoryURL: "https://github.com/acme/repo", githubEnrichment: &config,
	})
	if requests != 3 {
		t.Fatalf("requests = %d, want one commit-SHA lookup for each distinct author commit", requests)
	}
	wantNames := map[string]string{
		"ordinary.html": "Alice Example", "modern-noreply.html": "Octocat Author", "legacy-noreply.html": "Legacy Octocat",
	}
	for _, entry := range index.Artifacts {
		if entry.LastAuthor == nil || entry.LastAuthor.Name != wantNames[entry.Path] || entry.LastAuthor.GitHub == nil || entry.LastAuthor.GitHub.Login != "octocat" || entry.LastAuthor.GitHub.AvatarURL != "https://avatars.githubusercontent.com/u/583231?v=4" {
			t.Errorf("%s attribution = %+v", entry.Path, entry.LastAuthor)
		}
		if entry.LastCommitter == nil || entry.LastCommitter.Name != "GitHub" {
			t.Errorf("%s committer = %+v", entry.Path, entry.LastCommitter)
		}
	}
	publicIndex, err := os.ReadFile(filepath.Join(root, ".local", "attribution-test", "_indexes", "sre", "index.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, privateValue := range []string{"alice@example.invalid", "583231+octocat@users.noreply.github.com", "octocat@users.noreply.github.com", "web-flow@example.invalid", "workflow-token"} {
		if strings.Contains(string(publicIndex), privateValue) {
			t.Errorf("public index contains private Git/API input %q", privateValue)
		}
	}
}

func TestBuildKeepsNameOnlyIndexWhenGitHubLookupFails(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	root := initializeGitRepository(t)
	runGit(t, root, "remote", "add", "origin", "git@github.com:acme/repo.git")
	commitTime := time.Date(2026, 4, 5, 6, 7, 8, 0, time.UTC)
	writeFixtureFile(t, root, "artifacts/report.html", "<h1>Report</h1>")
	sha := commitWithGitDates(t, root, "publish report", "Alice Example", "alice@example.invalid", "GitHub", "web-flow@example.invalid", commitTime, commitTime)
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		return responseFor(request, http.StatusServiceUnavailable, `{"message":"private outage"}`, nil), nil
	})
	index := builtIndexFrom(t, root, "artifacts", BuildOptions{
		RepositoryURL: "https://github.com/acme/repo", githubEnrichment: &config,
	})
	if len(index.Artifacts) != 1 {
		t.Fatalf("artifacts = %d, want one", len(index.Artifacts))
	}
	author := index.Artifacts[0].LastAuthor
	if author == nil || author.Name != "Alice Example" || author.CommitSHA != sha || author.GitHub != nil {
		t.Fatalf("failed enrichment did not produce usable name-only index: %+v", author)
	}
}

func TestGitHubMissingTokenUnsupportedAndMismatchedRepositoriesDoNotRequest(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "")
	sha := strings.Repeat("b", 40)
	for _, test := range []struct {
		name      string
		sourceURL string
		origin    string
		withToken bool
	}{
		{name: "no token", sourceURL: "https://github.com/acme/repo", origin: "git@github.com:acme/repo.git"},
		{name: "enterprise", sourceURL: "https://github.example.com/acme/repo", origin: "ssh://git@github.example.com/acme/repo.git", withToken: true},
		{name: "metadata override mismatch", sourceURL: "https://github.com/other/repo", origin: "git@github.com:acme/repo.git", withToken: true},
		{name: "unsupported origin", sourceURL: "https://github.com/acme/repo", origin: "git@gitlab.com:acme/repo.git", withToken: true},
		{name: "nonstandard source port", sourceURL: "https://github.com:8443/acme/repo", origin: "git@github.com:acme/repo.git", withToken: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if test.withToken {
				t.Setenv("GITHUB_TOKEN", "secret-token")
			}
			called := 0
			config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
				called++
				return responseFor(request, http.StatusOK, githubResponse(sha, "octocat", ""), nil), nil
			})
			updates := map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Alice")}
			warning, err := enrichGitAuthors(context.Background(), githubTestMetadata(test.sourceURL, test.origin), updates, nil, config)
			if err != nil || warning != "" || called != 0 {
				t.Fatalf("warning=%q error=%v requests=%d; no enrichment request expected", warning, err, called)
			}
			if updates["one.md"].lastAuthor.GitHub != nil {
				t.Fatalf("unexpected account enrichment: %+v", updates["one.md"].lastAuthor.GitHub)
			}
		})
	}
}

func TestGitHubLookupOutcomesAndSanitizedWarning(t *testing.T) {
	sha := strings.Repeat("c", 40)
	for _, test := range []struct {
		name        string
		status      int
		body        string
		headers     map[string]string
		wantWarning bool
		wantLogin   string
		wantAvatar  string
		wantCalls   int
	}{
		{name: "null author is normal absence", status: 200, body: fmt.Sprintf(`{"sha":%q,"author":null}`, sha), wantCalls: 1},
		{name: "not found continues", status: 404, body: `private error body`, wantWarning: true, wantCalls: 1},
		{name: "unprocessable continues", status: 422, body: `bad request`, wantWarning: true, wantCalls: 1},
		{name: "wrong sha", status: 200, body: githubResponse(strings.Repeat("d", 40), "octocat", ""), wantWarning: true, wantCalls: 1},
		{name: "uppercase sha mismatch", status: 200, body: githubResponse(strings.Repeat("C", 40), "octocat", ""), wantWarning: true, wantCalls: 1},
		{name: "invalid login", status: 200, body: githubResponse(sha, "octocat/example", ""), wantWarning: true, wantCalls: 1},
		{name: "invalid avatar keeps login", status: 200, body: githubResponse(sha, "octocat", "http://avatars.githubusercontent.com/u/1"), wantWarning: true, wantLogin: "octocat", wantCalls: 1},
		{name: "no avatar means login only", status: 200, body: githubResponse(sha, "octocat", ""), wantLogin: "octocat", wantCalls: 1},
		{name: "bot account", status: 200, body: githubResponse(sha, "dependabot[bot]", "https://avatars.githubusercontent.com/u/2"), wantLogin: "dependabot[bot]", wantAvatar: "https://avatars.githubusercontent.com/u/2", wantCalls: 1},
		{name: "unauthorized stops", status: 401, body: `secret body`, wantWarning: true, wantCalls: 1},
		{name: "forbidden stops", status: 403, body: `secret body`, wantWarning: true, wantCalls: 1},
		{name: "rate limit stops", status: 429, body: `secret body`, wantWarning: true, wantCalls: 1},
		{name: "server error stops", status: 503, body: `secret body`, wantWarning: true, wantCalls: 1},
		{name: "redirect rejected", status: 302, body: `redirect body`, headers: map[string]string{"Location": "https://api.github.test/followed"}, wantWarning: true, wantCalls: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("GITHUB_TOKEN", "api-secret")
			calls := 0
			config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
				calls++
				return responseFor(request, test.status, test.body, test.headers), nil
			})
			updates := map[string]artifactGitUpdate{"report.md": githubTestUpdate(sha, "Git author")}
			warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
			if err != nil {
				t.Fatalf("enrichGitAuthors() error = %v", err)
			}
			if (warning != "") != test.wantWarning || calls != test.wantCalls {
				t.Fatalf("warning=%q calls=%d, wantWarning=%v calls=%d", warning, calls, test.wantWarning, test.wantCalls)
			}
			if strings.Contains(warning, "api-secret") || strings.Contains(warning, "secret body") || strings.Contains(warning, "private error body") || strings.Contains(warning, "bad request") {
				t.Fatalf("warning contains credential or response body: %q", warning)
			}
			account := updates["report.md"].lastAuthor.GitHub
			if test.wantLogin == "" {
				if account != nil {
					t.Fatalf("account = %+v, want absent", account)
				}
			} else if account == nil || account.Login != test.wantLogin || account.AvatarURL != test.wantAvatar {
				t.Fatalf("account = %+v, want login %q avatar %q", account, test.wantLogin, test.wantAvatar)
			}
		})
	}
}

func TestGitHubEnrichmentOrdersDistinctSHAsAndHonorsRequestLimit(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	sha1, sha2, sha3 := strings.Repeat("1", 40), strings.Repeat("2", 40), strings.Repeat("3", 40)
	var mu sync.Mutex
	var requested []string
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		mu.Lock()
		defer mu.Unlock()
		requested = append(requested, request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:])
		if request.URL.Query().Get("per_page") != "1" || request.URL.Query().Get("page") != "" {
			t.Errorf("commit endpoint query = %s; only one page is permitted", request.URL.RawQuery)
		}
		sha := requested[len(requested)-1]
		return responseFor(request, 200, githubResponse(sha, "octocat", "https://avatars.githubusercontent.com/u/1"), nil), nil
	})
	config.maxRequests = 2
	updates := map[string]artifactGitUpdate{
		"one.md":       githubTestUpdate(sha3, "Three"),
		"two.md":       githubTestUpdate(sha1, "One"),
		"three.md":     githubTestUpdate(sha2, "Two"),
		"duplicate.md": githubTestUpdate(sha1, "One"),
	}
	warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
	if err != nil {
		t.Fatal(err)
	}
	if len(requested) != 2 || requested[0] != sha1 || requested[1] != sha2 {
		t.Fatalf("ordered API requests = %v, want first two sorted distinct SHAs", requested)
	}
	if !strings.Contains(warning, "1 commits left unresolved") {
		t.Fatalf("request budget warning = %q", warning)
	}
	if updates["duplicate.md"].lastAuthor.GitHub == nil || updates["duplicate.md"].lastAuthor.GitHub.Login != "octocat" {
		t.Fatalf("deduplicated result not shared with duplicate SHA: %+v", updates["duplicate.md"].lastAuthor)
	}
	if updates["one.md"].lastAuthor.GitHub != nil {
		t.Fatalf("request-limit omission was guessed: %+v", updates["one.md"].lastAuthor)
	}
	if githubAPIRequestLimit != 100 || githubAPIResponseBodyLimit != 1<<20 || defaultGitHubEnrichmentConfig().totalTimeout != 30*time.Second || defaultGitHubEnrichmentConfig().requestTimeout != 5*time.Second {
		t.Fatal("fixed GitHub enrichment limits changed from 100 requests, 30 seconds, 5 seconds and 1 MiB")
	}
	_ = sha3
}

func TestGitHubEnrichmentTimeoutAndOversizeResponseAreOptional(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	sha := strings.Repeat("e", 40)
	calls := 0
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		if deadline, ok := request.Context().Deadline(); !ok || time.Until(deadline) > 25*time.Millisecond {
			t.Errorf("per-request deadline = %v, ok=%v; want about 20ms", deadline, ok)
		}
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	config.totalTimeout = 80 * time.Millisecond
	config.requestTimeout = 20 * time.Millisecond
	updates := map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Offline author")}
	started := time.Now()
	warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
	if err != nil || warning == "" || calls != 1 || time.Since(started) > 300*time.Millisecond {
		t.Fatalf("request timeout warning=%q err=%v calls=%d elapsed=%s", warning, err, calls, time.Since(started))
	}
	if updates["one.md"].lastAuthor.Name != "Offline author" || updates["one.md"].lastAuthor.GitHub != nil {
		t.Fatalf("timeout changed Git attribution: %+v", updates["one.md"].lastAuthor)
	}

	config = githubTestConfig(func(request *http.Request) (*http.Response, error) {
		return responseFor(request, 200, strings.Repeat("x", 17), nil), nil
	})
	config.maxBodyBytes = 16
	updates = map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Offline author")}
	warning, err = enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
	if err != nil || warning == "" || updates["one.md"].lastAuthor.GitHub != nil {
		t.Fatalf("oversize response warning=%q err=%v author=%+v", warning, err, updates["one.md"].lastAuthor)
	}
}

func TestGitHubTotalBudgetAndHardRequestCapStopSequentialLookups(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	shaValues := []string{strings.Repeat("1", 40), strings.Repeat("2", 40), strings.Repeat("3", 40)}
	calls := 0
	var firstDeadline time.Time
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		deadline, ok := request.Context().Deadline()
		if !ok {
			t.Error("request has no deadline")
		}
		if calls == 1 {
			firstDeadline = deadline
			select {
			case <-time.After(22 * time.Millisecond):
			case <-request.Context().Done():
				return nil, request.Context().Err()
			}
			sha := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
			return responseFor(request, 200, githubResponse(sha, "octocat", "https://avatars.githubusercontent.com/u/1"), nil), nil
		}
		if deadline.Sub(firstDeadline) > 5*time.Millisecond || deadline.Sub(firstDeadline) < -5*time.Millisecond {
			t.Errorf("request deadline moved during total budget: first=%s current=%s", firstDeadline, deadline)
		}
		<-request.Context().Done()
		return nil, request.Context().Err()
	})
	config.totalTimeout = 40 * time.Millisecond
	config.requestTimeout = time.Second
	updates := map[string]artifactGitUpdate{
		"one.md":   githubTestUpdate(shaValues[0], "One"),
		"two.md":   githubTestUpdate(shaValues[1], "Two"),
		"three.md": githubTestUpdate(shaValues[2], "Three"),
	}
	started := time.Now()
	warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
	if err != nil || calls != 2 || time.Since(started) > 300*time.Millisecond || !strings.Contains(warning, "1 commits left unresolved") {
		t.Fatalf("total budget warning=%q err=%v calls=%d elapsed=%s", warning, err, calls, time.Since(started))
	}
	if updates["one.md"].lastAuthor.GitHub == nil || updates["three.md"].lastAuthor.GitHub != nil {
		t.Fatalf("total budget result incomplete or guessed: %+v", updates)
	}

	config = githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		sha := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
		return responseFor(request, 200, githubResponse(sha, "octocat", "https://avatars.githubusercontent.com/u/1"), nil), nil
	})
	config.maxRequests = githubAPIRequestLimit
	calls = 0
	updates = make(map[string]artifactGitUpdate, githubAPIRequestLimit+1)
	for value := 1; value <= githubAPIRequestLimit+1; value++ {
		sha := fmt.Sprintf("%040x", value)
		updates[fmt.Sprintf("%03d.md", value)] = githubTestUpdate(sha, "Git author")
	}
	warning, err = enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
	if err != nil || calls != githubAPIRequestLimit || !strings.Contains(warning, "1 commits left unresolved") {
		t.Fatalf("hard request cap warning=%q err=%v calls=%d", warning, err, calls)
	}
}

func TestGitHubNotFoundContinuesButServerAndRateFailuresStop(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	sha1, sha2 := strings.Repeat("4", 40), strings.Repeat("5", 40)
	for _, test := range []struct {
		name       string
		firstCode  int
		firstHead  map[string]string
		wantCalls  int
		wantFirst  bool
		wantSecond bool
	}{
		{name: "404 continues", firstCode: 404, wantCalls: 2, wantSecond: true},
		{name: "422 continues", firstCode: 422, wantCalls: 2, wantSecond: true},
		{name: "500 stops", firstCode: 500, wantCalls: 1},
		{name: "403 stops", firstCode: 403, wantCalls: 1},
		{name: "exhausted header stops", firstCode: 200, firstHead: map[string]string{"X-RateLimit-Remaining": "0"}, wantCalls: 1, wantFirst: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
				calls++
				sha := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
				if calls == 1 {
					if test.firstCode == 200 {
						return responseFor(request, 200, githubResponse(sha1, "octocat", "https://avatars.githubusercontent.com/u/1"), test.firstHead), nil
					}
					return responseFor(request, test.firstCode, "failure", nil), nil
				}
				return responseFor(request, 200, githubResponse(sha, "octocat", "https://avatars.githubusercontent.com/u/1"), nil), nil
			})
			updates := map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha1, "One"), "two.md": githubTestUpdate(sha2, "Two")}
			warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
			if err != nil || warning == "" || calls != test.wantCalls {
				t.Fatalf("warning=%q err=%v calls=%d, want %d", warning, err, calls, test.wantCalls)
			}
			if (updates["one.md"].lastAuthor.GitHub != nil) != test.wantFirst || (updates["two.md"].lastAuthor.GitHub != nil) != test.wantSecond {
				t.Fatalf("results = one:%+v two:%+v", updates["one.md"].lastAuthor.GitHub, updates["two.md"].lastAuthor.GitHub)
			}
		})
	}
}

func TestGitHubTransportFailureStopsAndParentCancellationCancelsPreparation(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	sha1, sha2 := strings.Repeat("6", 40), strings.Repeat("7", 40)
	calls := 0
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		return nil, errors.New("private transport detail")
	})
	updates := map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha1, "One"), "two.md": githubTestUpdate(sha2, "Two")}
	warning, err := enrichGitAuthors(context.Background(), githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config)
	if err != nil || calls != 1 || warning == "" || strings.Contains(warning, "private transport detail") {
		t.Fatalf("transport failure warning=%q err=%v calls=%d", warning, err, calls)
	}

	parent, cancel := context.WithCancel(context.Background())
	config = githubTestConfig(func(request *http.Request) (*http.Response, error) {
		cancel()
		return responseFor(request, 200, githubResponse(sha1, "octocat", ""), nil), nil
	})
	updates = map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha1, "One")}
	if warning, err = enrichGitAuthors(parent, githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git"), updates, nil, config); !errors.Is(err, context.Canceled) || warning != "" {
		t.Fatalf("parent cancellation warning=%q err=%v", warning, err)
	}
}

func TestGitHubTrustedSnapshotIsReusedAndIncompleteSnapshotCanRetry(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "test-token")
	sha := strings.Repeat("f", 40)
	basePrior := func(account *ArtifactGitHubAccount) *PriorSiteState {
		return &PriorSiteState{RepositoryURL: "https://github.com/acme/repo", Documents: map[string]PriorDocument{
			"one.md": {LastAuthor: &ArtifactAuthor{Name: "Alice", CommitSHA: sha, GitHub: account}},
		}}
	}
	metadata := githubTestMetadata("https://github.com/acme/repo", "git@github.com:acme/repo.git")
	complete := &ArtifactGitHubAccount{Login: "octocat", AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4"}
	calls := 0
	config := githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		return responseFor(request, 500, "unavailable", nil), nil
	})
	updates := map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Alice")}
	warning, err := enrichGitAuthors(context.Background(), metadata, updates, basePrior(complete), config)
	if err != nil || warning != "" || calls != 0 || updates["one.md"].lastAuthor.GitHub.AvatarURL != complete.AvatarURL {
		t.Fatalf("complete snapshot reuse warning=%q err=%v calls=%d author=%+v", warning, err, calls, updates["one.md"].lastAuthor)
	}

	config = githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		return responseFor(request, 200, githubResponse(sha, "octocat-new", "https://avatars.githubusercontent.com/u/2?v=4"), nil), nil
	})
	loginOnly := &ArtifactGitHubAccount{Login: "octocat"}
	updates = map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Alice")}
	warning, err = enrichGitAuthors(context.Background(), metadata, updates, basePrior(loginOnly), config)
	if err != nil || warning != "" || calls != 1 {
		t.Fatalf("incomplete snapshot retry warning=%q err=%v calls=%d", warning, err, calls)
	}
	if got := updates["one.md"].lastAuthor.GitHub; got == nil || got.Login != "octocat-new" || got.AvatarURL != "https://avatars.githubusercontent.com/u/2?v=4" {
		t.Fatalf("successful pair did not replace the prior account atomically: %+v", got)
	}

	config = githubTestConfig(func(request *http.Request) (*http.Response, error) {
		calls++
		return responseFor(request, 503, "retry failed", nil), nil
	})
	updates = map[string]artifactGitUpdate{"one.md": githubTestUpdate(sha, "Alice")}
	warning, err = enrichGitAuthors(context.Background(), metadata, updates, basePrior(loginOnly), config)
	if err != nil || warning == "" || updates["one.md"].lastAuthor.GitHub == nil || updates["one.md"].lastAuthor.GitHub.Login != "octocat" || updates["one.md"].lastAuthor.GitHub.AvatarURL != "" {
		t.Fatalf("failed retry should retain validated login: warning=%q err=%v account=%+v", warning, err, updates["one.md"].lastAuthor.GitHub)
	}
}

func TestGitHubAvatarURLAndLoginValidation(t *testing.T) {
	for _, raw := range []string{
		"https://avatars.githubusercontent.com/u/1?v=4",
		"https://avatars.githubusercontent.com:443/u/1",
	} {
		if !ValidGitHubAvatarURL(raw) {
			t.Errorf("valid avatar rejected: %q", raw)
		}
	}
	for _, raw := range []string{
		"http://avatars.githubusercontent.com/u/1",
		"https://avatars.githubusercontent.com.evil.test/u/1",
		"https://user@avatars.githubusercontent.com/u/1",
		"https://avatars.githubusercontent.com:444/u/1",
		"https://avatars.githubusercontent.com/u/1#",
		"https://avatars.githubusercontent.com/",
	} {
		if ValidGitHubAvatarURL(raw) {
			t.Errorf("invalid avatar accepted: %q", raw)
		}
	}
	for _, login := range []string{"octocat", "A-1", "dependabot[bot]"} {
		if !ValidGitHubLogin(login) {
			t.Errorf("valid login rejected: %q", login)
		}
	}
	for _, login := range []string{"", "bad/name", "bad name", "[bot]", "octocat[Bot]", "octocat?x=1"} {
		if ValidGitHubLogin(login) {
			t.Errorf("invalid login accepted: %q", login)
		}
	}
}

func TestGitHubSourceAndOriginRepositoryParsing(t *testing.T) {
	for _, raw := range []string{"https://github.com/acme/repo", "https://github.com:443/Acme/Repo.git"} {
		if _, ok := parseGitHubSourceRepository(raw); !ok {
			t.Errorf("source repository rejected: %q", raw)
		}
	}
	for _, raw := range []string{"https://github.com/acme/repo/extra", "http://github.com/acme/repo", "https://github.com.evil/acme/repo", "https://github.com/acme/repo?token=x", "https://github.com:8443/acme/repo"} {
		if _, ok := parseGitHubSourceRepository(raw); ok {
			t.Errorf("invalid source repository accepted: %q", raw)
		}
	}
	for _, raw := range []string{"git@github.com:acme/repo.git", "https://github.com/acme/repo", "ssh://git@github.com/acme/repo.git"} {
		if _, ok := parseGitHubOrigin(raw); !ok {
			t.Errorf("origin repository rejected: %q", raw)
		}
	}
	for _, raw := range []string{"git@gitlab.com:acme/repo.git", "http://github.com/acme/repo", "https://github.com:8443/acme/repo"} {
		if _, ok := parseGitHubOrigin(raw); ok {
			t.Errorf("invalid origin accepted: %q", raw)
		}
	}
}
