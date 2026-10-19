package indexer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	githubAPIBaseURL           = "https://api.github.com"
	githubAPIVersion           = "2022-11-28"
	githubAPIRequestLimit      = 100
	githubAPIResponseBodyLimit = 1 << 20
)

var githubLoginPattern = regexp.MustCompile(`^[A-Za-z0-9-]+(?:\[bot\])?$`)
var gitObjectIDPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
var githubRepositoryComponentPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

type githubEnrichmentConfig struct {
	client         *http.Client
	baseURL        string
	totalTimeout   time.Duration
	requestTimeout time.Duration
	maxRequests    int
	maxBodyBytes   int64
}

func defaultGitHubEnrichmentConfig() githubEnrichmentConfig {
	return githubEnrichmentConfig{
		client:         http.DefaultClient,
		baseURL:        githubAPIBaseURL,
		totalTimeout:   30 * time.Second,
		requestTimeout: 5 * time.Second,
		maxRequests:    githubAPIRequestLimit,
		maxBodyBytes:   githubAPIResponseBodyLimit,
	}
}

type githubRepository struct {
	owner string
	name  string
}

func (repository githubRepository) key() string {
	return strings.ToLower(repository.owner + "/" + repository.name)
}

type attributionLookupKey struct {
	repository string
	sha        string
}

type attributionLookup struct {
	repository githubRepository
	sha        string
}

type githubCommitResponse struct {
	SHA    string `json:"sha"`
	Author *struct {
		Login     string `json:"login"`
		AvatarURL string `json:"avatar_url"`
	} `json:"author"`
}

// enrichGitAuthors attaches only commit-associated GitHub account metadata.
// Git identities and prior-index snapshots remain usable when lookup is absent
// or fails; only parent-context cancellation aborts preparation.
func enrichGitAuthors(ctx context.Context, metadata gitMetadata, updates map[string]artifactGitUpdate, prior *PriorSiteState, config githubEnrichmentConfig) (string, error) {
	currentRepository, currentOK := parseGitHubSourceRepository(metadata.repositoryURL)
	originRepository, originOK := parseGitHubOrigin(metadata.originRemote)
	repositoryMatches := currentOK && originOK && strings.EqualFold(currentRepository.key(), originRepository.key())
	if currentOK && prior != nil {
		for path, update := range updates {
			if update.lastAuthor == nil {
				continue
			}
			deployed, ok := prior.Documents[path]
			priorRepository, priorOK := parseGitHubSourceRepository(deployed.RepositoryURL)
			if !ok || !priorOK || !strings.EqualFold(currentRepository.key(), priorRepository.key()) || deployed.LastAuthor == nil || deployed.LastAuthor.CommitSHA != update.lastAuthor.CommitSHA || deployed.LastAuthor.GitHub == nil {
				continue
			}
			update.lastAuthor.GitHub = cloneGitHubAccount(deployed.LastAuthor.GitHub)
			updates[path] = update
		}
	}

	token := firstGitHubToken()
	if !repositoryMatches || token == "" {
		return "", nil
	}
	if config.client == nil {
		config.client = http.DefaultClient
	}
	if config.baseURL == "" {
		config.baseURL = githubAPIBaseURL
	}
	if config.totalTimeout <= 0 || config.requestTimeout <= 0 || config.maxRequests <= 0 || config.maxBodyBytes <= 0 {
		return "", errors.New("invalid internal GitHub enrichment limits")
	}

	keysByPath := make(map[string]attributionLookupKey)
	lookups := make(map[attributionLookupKey]attributionLookup)
	for path, update := range updates {
		if update.lastAuthor == nil {
			continue
		}
		key := attributionLookupKey{repository: currentRepository.key(), sha: update.lastAuthor.CommitSHA}
		keysByPath[path] = key
		if !hasCompleteGitHubAccount(update.lastAuthor.GitHub) {
			lookups[key] = attributionLookup{repository: currentRepository, sha: update.lastAuthor.CommitSHA}
		}
	}
	if len(lookups) == 0 {
		return "", nil
	}

	orderedKeys := make([]attributionLookupKey, 0, len(lookups))
	for key := range lookups {
		orderedKeys = append(orderedKeys, key)
	}
	sort.Slice(orderedKeys, func(i, j int) bool {
		if orderedKeys[i].sha != orderedKeys[j].sha {
			return orderedKeys[i].sha < orderedKeys[j].sha
		}
		return orderedKeys[i].repository < orderedKeys[j].repository
	})

	totalContext, cancel := context.WithTimeout(ctx, config.totalTimeout)
	defer cancel()
	client := *config.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

	results := make(map[attributionLookupKey]*ArtifactGitHubAccount, len(lookups))
	failures := 0
	requests := 0
	stop := false
	remainingStart := len(orderedKeys)
	for index, key := range orderedKeys {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if requests >= config.maxRequests {
			stop = true
			remainingStart = index
			break
		}
		if err := totalContext.Err(); err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			failures++
			stop = true
			remainingStart = index
			break
		}
		lookup := lookups[key]
		account, outcome, requestErr := lookupGitHubCommitAuthor(totalContext, &client, token, lookup.repository, lookup.sha, config)
		requests++
		if err := ctx.Err(); err != nil {
			return "", err
		}
		if requestErr != nil {
			failures++
			if outcome == "stop" {
				stop = true
				remainingStart = index + 1
				break
			}
			continue
		}
		if outcome == "invalid" {
			failures++
		}
		if account != nil {
			results[key] = account
		}
		if outcome == "rate-limited" {
			stop = true
			remainingStart = index + 1
			break
		}
		if index == len(orderedKeys)-1 {
			break
		}
	}

	for path, key := range keysByPath {
		update := updates[path]
		if update.lastAuthor == nil {
			continue
		}
		if account := results[key]; account != nil {
			update.lastAuthor.GitHub = mergeGitHubAccount(update.lastAuthor.GitHub, account)
			updates[path] = update
		}
	}

	omitted := 0
	if stop {
		omitted = len(orderedKeys) - remainingStart
	}
	if failures == 0 && omitted == 0 {
		return "", nil
	}
	return fmt.Sprintf("GitHub commit attribution was incomplete (%d lookup failures or invalid responses; %d commits left unresolved by the request budget or an early stop). Git author names and commit SHAs remain available.", failures, omitted), nil
}

func lookupGitHubCommitAuthor(parent context.Context, client *http.Client, token string, repository githubRepository, sha string, config githubEnrichmentConfig) (*ArtifactGitHubAccount, string, error) {
	if !gitObjectIDPattern.MatchString(sha) {
		return nil, "invalid", errors.New("invalid commit object ID")
	}
	endpoint, err := url.Parse(strings.TrimRight(config.baseURL, "/") + "/repos/" + url.PathEscape(repository.owner) + "/" + url.PathEscape(repository.name) + "/commits/" + url.PathEscape(sha))
	if err != nil {
		return nil, "invalid", err
	}
	query := endpoint.Query()
	query.Set("per_page", "1")
	endpoint.RawQuery = query.Encode()

	requestContext, cancel := context.WithTimeout(parent, config.requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, "invalid", err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-GitHub-Api-Version", githubAPIVersion)
	request.Header.Set("User-Agent", "artifact-pages-cli")
	response, err := client.Do(request)
	if err != nil {
		return nil, "stop", err
	}
	defer response.Body.Close()
	rateExhausted := strings.TrimSpace(response.Header.Get("X-RateLimit-Remaining")) == "0"
	switch response.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests:
		return nil, "stop", fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
	case http.StatusNotFound, http.StatusUnprocessableEntity:
		if rateExhausted {
			return nil, "stop", fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
		}
		return nil, "invalid", fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
	}
	if response.StatusCode >= 500 {
		return nil, "stop", fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
	}
	if response.StatusCode != http.StatusOK {
		if rateExhausted {
			return nil, "stop", fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
		}
		return nil, "invalid", fmt.Errorf("GitHub API returned HTTP %d", response.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, config.maxBodyBytes+1))
	if err != nil {
		return nil, "stop", err
	}
	if int64(len(body)) > config.maxBodyBytes {
		if rateExhausted {
			return nil, "stop", errors.New("GitHub API response exceeded the body limit")
		}
		return nil, "invalid", errors.New("GitHub API response exceeded the body limit")
	}
	var decoded githubCommitResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		if rateExhausted {
			return nil, "stop", errors.New("GitHub API response was invalid JSON")
		}
		return nil, "invalid", errors.New("GitHub API response was invalid JSON")
	}
	if decoded.SHA != sha {
		if rateExhausted {
			return nil, "stop", errors.New("GitHub API response SHA did not match")
		}
		return nil, "invalid", errors.New("GitHub API response SHA did not match")
	}
	if decoded.Author == nil {
		if rateExhausted {
			return nil, "rate-limited", nil
		}
		return nil, "null-author", nil
	}
	login := decoded.Author.Login
	if !validGitHubLogin(login) {
		if rateExhausted {
			return nil, "stop", errors.New("GitHub API author login was invalid")
		}
		return nil, "invalid", errors.New("GitHub API author login was invalid")
	}
	account := &ArtifactGitHubAccount{Login: login}
	if decoded.Author.AvatarURL != "" {
		if validGitHubAvatarURL(decoded.Author.AvatarURL) {
			account.AvatarURL = decoded.Author.AvatarURL
		} else {
			if rateExhausted {
				return account, "rate-limited", nil
			}
			return account, "invalid", nil
		}
	}
	if rateExhausted {
		return account, "rate-limited", nil
	}
	return account, "ok", nil
}

func mergeGitHubAccount(existing, fetched *ArtifactGitHubAccount) *ArtifactGitHubAccount {
	if fetched == nil || !validGitHubLogin(fetched.Login) {
		return cloneGitHubAccount(existing)
	}
	if validGitHubAvatarURL(fetched.AvatarURL) {
		return &ArtifactGitHubAccount{Login: fetched.Login, AvatarURL: fetched.AvatarURL}
	}
	if existing != nil && validGitHubLogin(existing.Login) {
		return cloneGitHubAccount(existing)
	}
	return &ArtifactGitHubAccount{Login: fetched.Login}
}

func hasCompleteGitHubAccount(account *ArtifactGitHubAccount) bool {
	return account != nil && validGitHubLogin(account.Login) && validGitHubAvatarURL(account.AvatarURL)
}

func validGitHubLogin(login string) bool {
	return githubLoginPattern.MatchString(login)
}

// ValidGitHubLogin reports whether a commit API account login can be published.
func ValidGitHubLogin(login string) bool { return validGitHubLogin(login) }

// ValidGitCommitSHA reports whether sha is a full lowercase SHA-1 or SHA-256 ID.
func ValidGitCommitSHA(sha string) bool { return gitObjectIDPattern.MatchString(sha) }

func validGitHubAvatarURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || !strings.EqualFold(parsed.Hostname(), "avatars.githubusercontent.com") || parsed.User != nil || parsed.Fragment != "" || parsed.RawFragment != "" || strings.Contains(raw, "#") {
		return false
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return false
	}
	path := parsed.EscapedPath()
	return parsed.Opaque == "" && strings.HasPrefix(path, "/") && path != "/"
}

// ValidGitHubAvatarURL reports whether raw satisfies the public avatar URL policy.
func ValidGitHubAvatarURL(raw string) bool { return validGitHubAvatarURL(raw) }

func cloneGitHubAccount(account *ArtifactGitHubAccount) *ArtifactGitHubAccount {
	if account == nil || !validGitHubLogin(account.Login) {
		return nil
	}
	cloned := &ArtifactGitHubAccount{Login: account.Login}
	if validGitHubAvatarURL(account.AvatarURL) {
		cloned.AvatarURL = account.AvatarURL
	}
	return cloned
}

func cloneArtifactAuthor(author *ArtifactAuthor) *ArtifactAuthor {
	if author == nil || strings.TrimSpace(author.Name) == "" || !gitObjectIDPattern.MatchString(author.CommitSHA) {
		return nil
	}
	return &ArtifactAuthor{Name: author.Name, CommitSHA: author.CommitSHA, GitHub: cloneGitHubAccount(author.GitHub)}
}

func firstGitHubToken() string {
	if token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN")); token != "" {
		return token
	}
	return strings.TrimSpace(os.Getenv("GH_TOKEN"))
}

func parseGitHubSourceRepository(raw string) (githubRepository, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || !strings.EqualFold(parsed.Scheme, "https") || !strings.EqualFold(parsed.Hostname(), "github.com") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return githubRepository{}, false
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return githubRepository{}, false
	}
	return parseGitHubPath(parsed.Path)
}

func parseGitHubOrigin(raw string) (githubRepository, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return githubRepository{}, false
	}
	if strings.Contains(raw, "://") {
		parsed, err := url.Parse(raw)
		if err != nil || parsed.User != nil && !strings.EqualFold(parsed.Scheme, "ssh") || parsed.RawQuery != "" || parsed.Fragment != "" {
			return githubRepository{}, false
		}
		scheme := strings.ToLower(parsed.Scheme)
		if (scheme != "https" && scheme != "ssh") || !strings.EqualFold(parsed.Hostname(), "github.com") {
			return githubRepository{}, false
		}
		if port := parsed.Port(); port != "" && scheme == "https" && port != "443" {
			return githubRepository{}, false
		}
		return parseGitHubPath(parsed.Path)
	}
	separator := strings.Index(raw, ":")
	if separator < 0 {
		return githubRepository{}, false
	}
	host := raw[:separator]
	if at := strings.LastIndex(host, "@"); at >= 0 {
		host = host[at+1:]
	}
	if !strings.EqualFold(host, "github.com") {
		return githubRepository{}, false
	}
	return parseGitHubPath(raw[separator+1:])
}

func parseGitHubPath(raw string) (githubRepository, bool) {
	trimmed := raw
	if strings.HasPrefix(trimmed, "/") {
		trimmed = strings.TrimPrefix(trimmed, "/")
	}
	if strings.HasSuffix(trimmed, "/") {
		trimmed = strings.TrimSuffix(trimmed, "/")
	}
	trimmed = strings.TrimSuffix(trimmed, ".git")
	parts := strings.Split(trimmed, "/")
	if len(parts) != 2 || !githubRepositoryComponentPattern.MatchString(parts[0]) || !githubRepositoryComponentPattern.MatchString(parts[1]) || parts[0] == "." || parts[0] == ".." || parts[1] == "." || parts[1] == ".." {
		return githubRepository{}, false
	}
	return githubRepository{owner: parts[0], name: parts[1]}, true
}
