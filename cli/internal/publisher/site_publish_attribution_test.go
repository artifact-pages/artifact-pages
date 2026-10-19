package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"testing"
)

type attributionRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip attributionRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestSiteSyncNoOpDefersGitHubAndReconcileFillsAtSameInputRoot(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "")
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	initial, err := PublishSite(context.Background(), backend, options)
	if err != nil || initial.Outcome != "synced" {
		t.Fatalf("initial tokenless publish = %+v, %v", initial, err)
	}
	stateBeforeObject, etagBefore, err := backend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	stateBefore, err := decodeSitePublishState("sre", sitePublishStateInfo(stateBeforeObject, etagBefore), stateBeforeObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv("GITHUB_TOKEN", "stub-token")
	oldClient := http.DefaultClient
	requests := 0
	http.DefaultClient = &http.Client{Transport: attributionRoundTripper(func(request *http.Request) (*http.Response, error) {
		requests++
		if !strings.Contains(request.URL.Path, "/commits/") {
			t.Errorf("unexpected GitHub request path %q", request.URL.Path)
		}
		if request.Header.Get("X-GitHub-Api-Version") != "2022-11-28" {
			t.Errorf("GitHub API version = %q", request.Header.Get("X-GitHub-Api-Version"))
		}
		command := exec.Command("git", "rev-parse", "HEAD")
		command.Dir = root
		shaBytes, commandErr := command.Output()
		if commandErr != nil {
			return nil, commandErr
		}
		body := fmt.Sprintf(`{"sha":%q,"author":{"login":"octocat","avatar_url":"https://avatars.githubusercontent.com/u/1?v=4"}}`, strings.TrimSpace(string(shaBytes)))
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}
	defer func() { http.DefaultClient = oldClient }()

	noop, err := PublishSite(context.Background(), backend, options)
	if err != nil || noop.Outcome != "no-op" || !noop.BuildSkipped || requests != 0 {
		t.Fatalf("token-added ordinary publish = %+v, %v, GitHub requests=%d; want no-op and zero requests", noop, err, requests)
	}

	options.Reconcile = true
	reconciled, err := PublishSite(context.Background(), backend, options)
	if err != nil || reconciled.Outcome != "synced" || requests != 1 {
		t.Fatalf("reconcile attribution fill = %+v, %v, GitHub requests=%d; want synced and one deduplicated lookup", reconciled, err, requests)
	}
	indexObject, _, err := backend.GetObject(context.Background(), "_indexes/sre/index.json")
	if err != nil {
		t.Fatal(err)
	}
	var index struct {
		Artifacts []struct {
			LastAuthor *struct {
				GitHub *struct {
					Login string `json:"login"`
				} `json:"github"`
			} `json:"lastAuthor"`
		} `json:"artifacts"`
	}
	if err := json.Unmarshal(indexObject.Bytes, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Artifacts) == 0 || index.Artifacts[0].LastAuthor == nil || index.Artifacts[0].LastAuthor.GitHub == nil || index.Artifacts[0].LastAuthor.GitHub.Login != "octocat" {
		t.Fatalf("reconciled index attribution = %+v", index.Artifacts)
	}
	stateAfterObject, etagAfter, err := backend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	stateAfter, err := decodeSitePublishState("sre", sitePublishStateInfo(stateAfterObject, etagAfter), stateAfterObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if stateAfter.Committed.InputRoot != stateBefore.Committed.InputRoot {
		t.Fatalf("enrichment changed committed input root: before=%s after=%s", stateBefore.Committed.InputRoot, stateAfter.Committed.InputRoot)
	}
}
