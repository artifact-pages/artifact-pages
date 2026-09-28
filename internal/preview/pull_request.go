package preview

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const defaultGitHubAPIBaseURL = "https://api.github.com"

var pullRequestNumberPattern = regexp.MustCompile(`^[1-9][0-9]*$`)

// PullRequestResolver fetches the metadata needed to verify explicit PR
// provenance. A nil client uses a bounded default HTTP client. APIBaseURL is
// exposed for deterministic tests; callers must not populate it from untrusted
// command-line input.
type PullRequestResolver struct {
	Client     *http.Client
	APIBaseURL string
	Token      string
}

type PullRequestInfo struct {
	Number       int
	URL          string
	BaseRepo     string
	HeadRepo     string
	HeadSHA      string
	HeadRepoGone bool
}

type pullRequestResponse struct {
	Number  int    `json:"number"`
	HTMLURL string `json:"html_url"`
	Base    struct {
		Repo struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"base"`
	Head struct {
		SHA  string `json:"sha"`
		Repo *struct {
			FullName string `json:"full_name"`
		} `json:"repo"`
	} `json:"head"`
}

// Resolve validates an explicit number or canonical GitHub pull URL against
// the registered repository, then fetches base/head identity from the GitHub
// REST API. It never discovers a PR from a branch, commit, or CI environment.
func (resolver PullRequestResolver) Resolve(ctx context.Context, repository, reference string) (PullRequestInfo, error) {
	registeredRepository, err := normalizeRepository(repository)
	if err != nil {
		return PullRequestInfo{}, err
	}
	number, err := parsePullRequestReference(registeredRepository, reference)
	if err != nil {
		return PullRequestInfo{}, err
	}
	baseURL := resolver.APIBaseURL
	if baseURL == "" {
		baseURL = defaultGitHubAPIBaseURL
	}
	parsedBase, err := url.Parse(baseURL)
	if err != nil || parsedBase.Scheme == "" || parsedBase.Host == "" || parsedBase.RawQuery != "" || parsedBase.Fragment != "" {
		return PullRequestInfo{}, errors.New("GitHub API base URL is invalid")
	}
	parsedBase.Path = path.Join(parsedBase.Path, "repos", registeredRepository, "pulls", strconv.Itoa(number))
	parsedBase.RawPath = ""
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsedBase.String(), nil)
	if err != nil {
		return PullRequestInfo{}, fmt.Errorf("create GitHub pull request lookup: %w", err)
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "git-artifact-pages")
	request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if resolver.Token != "" {
		request.Header.Set("Authorization", "Bearer "+resolver.Token)
	}
	client := resolver.Client
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return PullRequestInfo{}, fmt.Errorf("read GitHub pull request metadata: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return PullRequestInfo{}, fmt.Errorf("GitHub pull request lookup returned HTTP %d", response.StatusCode)
	}
	var decoded pullRequestResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&decoded); err != nil {
		return PullRequestInfo{}, fmt.Errorf("decode GitHub pull request metadata: %w", err)
	}
	if decoded.Number != number {
		return PullRequestInfo{}, fmt.Errorf("GitHub returned pull request %d for requested number %d", decoded.Number, number)
	}
	baseRepository, err := normalizeRepository(decoded.Base.Repo.FullName)
	if err != nil || !strings.EqualFold(baseRepository, registeredRepository) {
		return PullRequestInfo{}, fmt.Errorf("pull request #%d does not target registered repository %q", number, registeredRepository)
	}
	if !shaPattern.MatchString(decoded.Head.SHA) {
		return PullRequestInfo{}, fmt.Errorf("pull request #%d returned an invalid head SHA", number)
	}
	info := PullRequestInfo{Number: number, BaseRepo: baseRepository, HeadSHA: decoded.Head.SHA}
	if decoded.Head.Repo == nil {
		info.HeadRepoGone = true
		return PullRequestInfo{}, fmt.Errorf("pull request #%d no longer has an available head repository", number)
	}
	info.HeadRepo, err = normalizeRepository(decoded.Head.Repo.FullName)
	if err != nil || !strings.EqualFold(info.HeadRepo, registeredRepository) {
		return PullRequestInfo{}, fmt.Errorf("pull request #%d must originate from registered repository %q", number, registeredRepository)
	}
	info.URL = "https://github.com/" + registeredRepository + "/pull/" + strconv.Itoa(number)
	if decoded.HTMLURL != "" && decoded.HTMLURL != info.URL && !strings.EqualFold(decoded.HTMLURL, info.URL) {
		return PullRequestInfo{}, fmt.Errorf("GitHub returned a non-canonical URL for pull request #%d", number)
	}
	return info, nil
}

func parsePullRequestReference(repository, reference string) (int, error) {
	if pullRequestNumberPattern.MatchString(reference) {
		number, err := strconv.Atoi(reference)
		if err != nil {
			return 0, fmt.Errorf("pull request number %q is out of range", reference)
		}
		return number, nil
	}
	parsed, err := url.Parse(reference)
	if err != nil || parsed.Scheme != "https" || parsed.Host != "github.com" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || strings.ContainsAny(reference, "?#") {
		return 0, fmt.Errorf("pull request reference %q must be a positive number or canonical GitHub pull URL", reference)
	}
	parts := strings.Split(strings.Trim(parsed.Path, "/"), "/")
	if len(parts) != 4 || parts[0] == "" || parts[1] == "" || parts[2] != "pull" || !pullRequestNumberPattern.MatchString(parts[3]) {
		return 0, fmt.Errorf("pull request URL %q must use https://github.com/<owner>/<repo>/pull/<number>", reference)
	}
	if parsed.EscapedPath() != "/"+strings.Join(parts, "/") {
		return 0, fmt.Errorf("pull request URL %q is not canonical", reference)
	}
	if !strings.EqualFold(parts[0]+"/"+parts[1], repository) {
		return 0, fmt.Errorf("pull request URL %q does not belong to registered repository %q", reference, repository)
	}
	number, err := strconv.Atoi(parts[3])
	if err != nil {
		return 0, fmt.Errorf("pull request number in %q is out of range", reference)
	}
	return number, nil
}

// ParsePullRequestReference validates an explicit pull request number or URL
// against a registered repository without making an API request.
func ParsePullRequestReference(repository, reference string) (int, error) {
	registeredRepository, err := normalizeRepository(repository)
	if err != nil {
		return 0, err
	}
	return parsePullRequestReference(registeredRepository, reference)
}
