package publisher

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/indexer"
)

type attributionRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip attributionRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestSiteSyncNoOpDefersGitHubAndReconcileFillsAtSameInputRoot(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "")
	t.Setenv("GITHUB_REPOSITORY", "acme/sre")
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	if err := os.MkdirAll(filepath.Join(root, "docs", "artifacts", "other"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docs", "artifacts", "other", "alternate.html"), []byte("<title>Alternate</title><h1>Alternate</h1>"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGitAt(root, "add", "docs/artifacts/other/alternate.html"); err != nil {
		t.Fatal(err)
	}
	if err := runPublisherGitAt(root, "commit", "--quiet", "--amend", "-m", "add publisher fixtures"); err != nil {
		t.Fatal(err)
	}
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
	responseLogin := "octocat"
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
		body := fmt.Sprintf(`{"sha":%q,"author":{"login":%q,"avatar_url":"https://avatars.githubusercontent.com/u/1?v=4"}}`, strings.TrimSpace(string(shaBytes)), responseLogin)
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: request}, nil
	})}
	defer func() { http.DefaultClient = oldClient }()

	noop, err := PublishSite(context.Background(), backend, options)
	if err != nil || noop.Outcome != "no-op" || !noop.BuildSkipped || requests != 0 {
		t.Fatalf("token-added ordinary publish = %+v, %v, GitHub requests=%d; want no-op and zero requests", noop, err, requests)
	}

	resource := filepath.Join(root, "docs", "artifacts", "assets", "theme.css")
	if err := os.MkdirAll(filepath.Dir(resource), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(resource, []byte("body{color:navy}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	changed, err := PublishSite(context.Background(), backend, options)
	if err != nil || changed.Outcome != "synced" || requests != 1 {
		t.Fatalf("changed-input attribution fill = %+v, %v, GitHub requests=%d; want one deduplicated lookup", changed, err, requests)
	}
	changedCalls, _, _, _ := backend.sitePublishScaleBackend.countSnapshot()
	if changedCalls["GET.projection"] > 1 || changedCalls["HEAD.projection"] != 0 {
		t.Fatalf("changed-input projection reads = %v; want at most one GET and no HEAD", changedCalls)
	}
	stateChangedObject, etagChanged, err := backend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	stateChanged, err := decodeSitePublishState("sre", sitePublishStateInfo(stateChangedObject, etagChanged), stateChangedObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if stateChanged.Committed.InputRoot == stateBefore.Committed.InputRoot {
		t.Fatal("changed source did not change the input root")
	}

	setPriorGitHubSnapshots(t, backend, func(path string) string {
		if path == "report.html" {
			return "complete"
		}
		return "absent"
	})
	responseLogin = "refreshed-login"
	requests = 0
	options.Reconcile = true
	reconciled, err := PublishSite(context.Background(), backend, options)
	if err != nil || reconciled.Outcome != "synced" || requests != 1 {
		t.Fatalf("reconcile attribution fill = %+v, %v, GitHub requests=%d; want one lookup for the incomplete same-SHA document", reconciled, err, requests)
	}
	indexObject, _, err := backend.GetObject(context.Background(), "_indexes/sre/index.json")
	if err != nil {
		t.Fatal(err)
	}
	var index struct {
		Artifacts []struct {
			Path       string `json:"path"`
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
	accounts := map[string]string{}
	for _, artifact := range index.Artifacts {
		if artifact.LastAuthor != nil && artifact.LastAuthor.GitHub != nil {
			accounts[artifact.Path] = artifact.LastAuthor.GitHub.Login
		}
	}
	if accounts["report.html"] != "octocat" || accounts["other/alternate.html"] != "refreshed-login" {
		t.Fatalf("reconciled same-SHA accounts = %+v; complete pair should remain and incomplete pair should fill", accounts)
	}
	stateAfterObject, etagAfter, err := backend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	stateAfter, err := decodeSitePublishState("sre", sitePublishStateInfo(stateAfterObject, etagAfter), stateAfterObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if stateAfter.Committed.InputRoot != stateChanged.Committed.InputRoot {
		t.Fatalf("reconciliation enrichment changed committed input root: before=%s after=%s", stateChanged.Committed.InputRoot, stateAfter.Committed.InputRoot)
	}
}

func setPriorGitHubSnapshot(t *testing.T, backend *sitePublishProbeBackend, association string) {
	t.Helper()
	setPriorGitHubSnapshots(t, backend, func(string) string { return association })
}

func setPriorGitHubSnapshots(t *testing.T, backend *sitePublishProbeBackend, associationForPath func(string) string) {
	t.Helper()
	ctx := context.Background()
	const indexKey = "_indexes/sre/index.json"
	indexObject, _, err := backend.GetObject(ctx, indexKey)
	if err != nil {
		t.Fatal(err)
	}
	var index indexer.SiteIndex
	if err := json.Unmarshal(indexObject.Bytes, &index); err != nil {
		t.Fatal(err)
	}
	for i := range index.Artifacts {
		if index.Artifacts[i].LastAuthor == nil {
			t.Fatalf("artifact %s has no Git author", index.Artifacts[i].Path)
		}
		association := associationForPath(index.Artifacts[i].Path)
		switch association {
		case "complete":
			index.Artifacts[i].LastAuthor.GitHub = &indexer.ArtifactGitHubAccount{Login: "octocat", AvatarURL: "https://avatars.githubusercontent.com/u/1?v=4"}
		case "login-only":
			index.Artifacts[i].LastAuthor.GitHub = &indexer.ArtifactGitHubAccount{Login: "octocat"}
		case "absent":
			index.Artifacts[i].LastAuthor.GitHub = nil
		default:
			t.Fatalf("unknown association %q", association)
		}
	}
	indexObject.Bytes, err = json.MarshalIndent(index, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	indexObject.Bytes = append(indexObject.Bytes, '\n')
	indexObject.Metadata["artifact-pages-sha256"] = sha256Hex(indexObject.Bytes)
	if err := backend.PutObject(ctx, indexKey, indexObject); err != nil {
		t.Fatal(err)
	}
	stateObject, stateETag, err := backend.GetObject(ctx, sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeSitePublishState("sre", sitePublishStateInfo(stateObject, stateETag), stateObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	for i := range state.Committed.Objects {
		row := &state.Committed.Objects[i]
		if row.Key == indexKey {
			row.SHA256, row.Size = sha256Hex(indexObject.Bytes), int64(len(indexObject.Bytes))
		}
	}
	stateObject, err = buildSitePublishStateObject("sre", state)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutObject(ctx, sitePublishStateKey("sre"), stateObject); err != nil {
		t.Fatal(err)
	}
}

func TestNoOpRequestMatrixIgnoresGitHubAssociationAndToken(t *testing.T) {
	for _, provider := range []string{"AWS", "R2"} {
		for _, association := range []string{"complete", "login-only", "absent"} {
			for _, withToken := range []bool{false, true} {
				name := fmt.Sprintf("%s/%s/token=%t", provider, association, withToken)
				t.Run(name, func(t *testing.T) {
					t.Setenv("GITHUB_TOKEN", "")
					t.Setenv("GH_TOKEN", "")
					t.Setenv("GITHUB_REPOSITORY", "acme/sre")
					_ = createPublisherCheckout(t, "git@github.com:acme/sre.git")
					probe := newSitePublishProbeBackend()
					seedPublisherRegistry(t, probe.lockMemoryBackend, registeredSREManifest)
					var backend DeploymentBackend = probe
					if provider == "R2" {
						backend = &sitePublishGetOnlyProbeBackend{probe}
					}
					options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
					if result, err := PublishSite(context.Background(), backend, options); err != nil || result.Outcome != "synced" {
						t.Fatalf("initial publish = %+v, %v", result, err)
					}
					setPriorGitHubSnapshot(t, probe, association)
					if withToken {
						t.Setenv("GITHUB_TOKEN", "stub-token")
					}
					requests := 0
					oldClient := http.DefaultClient
					http.DefaultClient = &http.Client{Transport: attributionRoundTripper(func(request *http.Request) (*http.Response, error) {
						requests++
						return &http.Response{StatusCode: http.StatusInternalServerError, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("failed")), Request: request}, nil
					})}
					defer func() { http.DefaultClient = oldClient }()
					probe.resetProbe()
					result, err := PublishSite(context.Background(), backend, options)
					if err != nil || result.Outcome != "no-op" || !result.BuildSkipped || requests != 0 {
						t.Fatalf("no-op = %+v, %v; GitHub requests=%d", result, err, requests)
					}
					probe.probeMu.Lock()
					heads, gets, writes, projectionHeads, projectionLists := probe.stateHeads, probe.stateGets, probe.stateWrites, probe.projectionHeads, probe.projectionLists
					probe.probeMu.Unlock()
					calls, _, _, _ := probe.sitePublishScaleBackend.countSnapshot()
					wantHeads, wantGets := 1, 0
					if provider == "R2" {
						wantHeads, wantGets = 0, 1
					}
					if heads != wantHeads || gets != wantGets || writes != 0 || projectionHeads != 0 || projectionLists != 0 ||
						calls["GET.projection"] != 0 || calls["PUT.projection"] != 0 || calls["DELETE.projection"] != 0 || calls["LIST.projection"] != 0 || calls["HEAD.projection"] != 0 {
						t.Fatalf("no-op requests state=%d/%d/%d projection=%v; want state %d/%d/0 and zero projection", heads, gets, writes, calls, wantHeads, wantGets)
					}
				})
			}
		}
	}
}

func TestBlankAuthorOmissionCanBeReDerivedWithoutRepublishing(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("GH_TOKEN", "")
	root := createPublisherCheckout(t, "git@github.com:acme/sre.git")
	treeCommand := exec.Command("git", "rev-parse", "HEAD^{tree}")
	treeCommand.Dir = root
	treeBytes, err := treeCommand.Output()
	if err != nil {
		t.Fatal(err)
	}
	date := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC).Unix()
	commit := fmt.Sprintf("tree %s\nauthor    <blank@example.invalid> %d +0000\ncommitter GitHub <web-flow@example.invalid> %d +0000\n\nwhitespace author\n", strings.TrimSpace(string(treeBytes)), date, date)
	commitCommand := exec.Command("git", "hash-object", "-t", "commit", "-w", "--stdin")
	commitCommand.Dir = root
	commitCommand.Stdin = strings.NewReader(commit)
	commitBytes, err := commitCommand.Output()
	if err != nil {
		t.Fatalf("write whitespace-author commit: %v", err)
	}
	blankSHA := strings.TrimSpace(string(commitBytes))
	if err := runPublisherGitAt(root, "update-ref", "HEAD", blankSHA); err != nil {
		t.Fatal(err)
	}
	nameCommand := exec.Command("git", "show", "-s", "--format=%an", "HEAD")
	nameCommand.Dir = root
	nameBytes, err := nameCommand.Output()
	if err != nil || strings.TrimSpace(string(nameBytes)) != "" {
		t.Fatalf("Git author name = %q, %v; want whitespace-only author", nameBytes, err)
	}

	backend := newSitePublishProbeBackend()
	seedPublisherRegistry(t, backend.lockMemoryBackend, registeredSREManifest)
	options := SitePublishOptions{SiteID: "sre", SourceDir: "docs/artifacts"}
	first, err := PublishSite(context.Background(), backend, options)
	if err != nil || first.Outcome != "synced" {
		t.Fatalf("initial publish = %+v, %v", first, err)
	}
	indexObject, _, err := backend.GetObject(context.Background(), "_indexes/sre/index.json")
	if err != nil {
		t.Fatal(err)
	}
	var index struct {
		Artifacts []map[string]json.RawMessage `json:"artifacts"`
	}
	if err := json.Unmarshal(indexObject.Bytes, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Artifacts) == 0 {
		t.Fatal("published index has no artifacts")
	}
	for _, artifact := range index.Artifacts {
		if _, exists := artifact["lastAuthor"]; exists {
			t.Fatalf("blank-author artifact emitted lastAuthor: %s", artifact["lastAuthor"])
		}
	}
	stateObject, stateETag, err := backend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	state, err := decodeSitePublishState("sre", sitePublishStateInfo(stateObject, stateETag), stateObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	second, err := PublishSite(context.Background(), backend, options)
	if err != nil || second.Outcome != "no-op" || !second.BuildSkipped {
		t.Fatalf("repeated blank-author publish = %+v, %v; want no-op after re-derivation", second, err)
	}
	stateAfterObject, stateAfterETag, err := backend.GetObject(context.Background(), sitePublishStateKey("sre"))
	if err != nil {
		t.Fatal(err)
	}
	stateAfter, err := decodeSitePublishState("sre", sitePublishStateInfo(stateAfterObject, stateAfterETag), stateAfterObject.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if stateAfter.Committed.InputRoot != state.Committed.InputRoot {
		t.Fatalf("repeated blank-author derivation changed input root: %s -> %s", state.Committed.InputRoot, stateAfter.Committed.InputRoot)
	}
}
