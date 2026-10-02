package publisher

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func TestValidReleaseRepositoryValidatesRepositoryNameComponent(t *testing.T) {
	for _, name := range []string{".github", "platform.config", "123project"} {
		if !validReleaseRepository("Acme/" + name) {
			t.Errorf("validReleaseRepository(%q) = false, want true", name)
		}
	}

	for _, name := range []string{strings.Repeat("a", 101), "..", "repo/child", "repo?name", "repo.git", "repo.GIT"} {
		if validReleaseRepository("Acme/" + name) {
			t.Errorf("validReleaseRepository(%q) = true, want false", name)
		}
	}
}

func TestDeployAppDownloadsPublishedVersionOverHTTPS(t *testing.T) {
	archivePath := createWebBundle(t, map[string][]byte{
		"index.html":       []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js":    []byte("console.log('release')"),
		"assets/theme.css": []byte("body { color: #123; }"),
	})
	archiveName := filepath.Base(archivePath)
	assets := make(map[string][]byte)
	for _, suffix := range []string{"", ".json", ".sha256"} {
		contents, err := os.ReadFile(archivePath + suffix)
		if err != nil {
			t.Fatalf("read release fixture %s: %v", suffix, err)
		}
		assets["/tasuku43/git-artifact-pages/releases/download/vtest-1/"+archiveName+suffix] = contents
	}

	var serverMu sync.Mutex
	var servedPaths []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		serverMu.Lock()
		servedPaths = append(servedPaths, request.URL.EscapedPath())
		serverMu.Unlock()
		if request.Method != http.MethodGet {
			http.Error(writer, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		contents, ok := assets[request.URL.EscapedPath()]
		if !ok {
			http.NotFound(writer, request)
			return
		}
		_, _ = writer.Write(contents)
	}))
	defer server.Close()

	localURL, err := url.Parse(server.URL)
	if err != nil {
		t.Fatalf("parse local HTTPS server URL: %v", err)
	}
	router := &localReleaseRoundTripper{
		target: localURL,
		next:   server.Client().Transport,
	}
	previousTransport := http.DefaultTransport
	http.DefaultTransport = router
	defer func() { http.DefaultTransport = previousTransport }()

	backend := &memoryDeploymentBackend{objects: make(map[string]Object)}
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{
		Version:    "test-1",
		Repository: "tasuku43/git-artifact-pages",
	})
	if err != nil {
		t.Fatalf("DeployApp() published version error = %v", err)
	}
	if result.Version != "test-1" || result.Outcome != "deployed" || result.FilesPublished != 3 {
		t.Fatalf("DeployApp() = %+v, want successful deployment of all three release files", result)
	}

	wantURLs := []string{
		"https://github.com/tasuku43/git-artifact-pages/releases/download/vtest-1/" + archiveName,
		"https://github.com/tasuku43/git-artifact-pages/releases/download/vtest-1/" + archiveName + ".json",
		"https://github.com/tasuku43/git-artifact-pages/releases/download/vtest-1/" + archiveName + ".sha256",
	}
	if got := router.requestURLs(); !reflect.DeepEqual(got, wantURLs) {
		t.Fatalf("release asset URLs = %#v, want %#v", got, wantURLs)
	}
	wantPaths := []string{
		"/tasuku43/git-artifact-pages/releases/download/vtest-1/" + archiveName,
		"/tasuku43/git-artifact-pages/releases/download/vtest-1/" + archiveName + ".json",
		"/tasuku43/git-artifact-pages/releases/download/vtest-1/" + archiveName + ".sha256",
	}
	serverMu.Lock()
	gotPaths := append([]string(nil), servedPaths...)
	serverMu.Unlock()
	if !reflect.DeepEqual(gotPaths, wantPaths) {
		t.Fatalf("local HTTPS server paths = %#v, want %#v", gotPaths, wantPaths)
	}

	wantFiles := map[string][]byte{
		"index.html":       []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js":    []byte("console.log('release')"),
		"assets/theme.css": []byte("body { color: #123; }"),
	}
	if len(backend.objects) != len(wantFiles) {
		t.Fatalf("deployed object keys = %#v, want %d files", backend.objects, len(wantFiles))
	}
	for key, want := range wantFiles {
		object, ok := backend.objects[key]
		if !ok {
			t.Errorf("DeployApp() did not publish resolved file %q", key)
			continue
		}
		if string(object.Bytes) != string(want) {
			t.Errorf("published %s = %q, want %q", key, object.Bytes, want)
		}
		if object.Metadata["artifact-pages-version"] != "test-1" {
			t.Errorf("published %s version metadata = %q, want test-1", key, object.Metadata["artifact-pages-version"])
		}
	}
}

type localReleaseRoundTripper struct {
	target *url.URL
	next   http.RoundTripper

	mu   sync.Mutex
	urls []string
}

func (transport *localReleaseRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.Scheme != "https" {
		return nil, fmt.Errorf("release request scheme = %q, want https", request.URL.Scheme)
	}
	transport.mu.Lock()
	transport.urls = append(transport.urls, request.URL.String())
	transport.mu.Unlock()

	routed := request.Clone(request.Context())
	routedURL := *request.URL
	routedURL.Scheme = transport.target.Scheme
	routedURL.Host = transport.target.Host
	routed.URL = &routedURL
	routed.Host = transport.target.Host
	return transport.next.RoundTrip(routed)
}

func (transport *localReleaseRoundTripper) requestURLs() []string {
	transport.mu.Lock()
	defer transport.mu.Unlock()
	return append([]string(nil), transport.urls...)
}

func TestDeployAppExplainsUnreachablePinnedRelease(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	localURL, _ := url.Parse(server.URL)
	previousTransport := http.DefaultTransport
	http.DefaultTransport = &localReleaseRoundTripper{target: localURL, next: server.Client().Transport}
	defer func() { http.DefaultTransport = previousTransport }()

	backend := &memoryDeploymentBackend{objects: make(map[string]Object)}
	_, err := DeployApp(context.Background(), backend, AppDeployOptions{Version: "9.9.9", Repository: "acme/pages"})
	if err == nil {
		t.Fatal("DeployApp() error = nil for a release that does not exist")
	}
	for _, want := range []string{"cannot fetch web release v9.9.9 from acme/pages", "HTTP 404", "--archive"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not contain %q", err, want)
		}
	}
	if len(backend.objects) != 0 {
		t.Fatalf("failed download wrote objects: %v", backend.objects)
	}
}

func TestDeployAppRequiresArchiveOrPinnedVersion(t *testing.T) {
	_, err := DeployApp(context.Background(), &memoryDeploymentBackend{objects: make(map[string]Object)}, AppDeployOptions{})
	if err == nil {
		t.Fatal("DeployApp() error = nil without archive or version")
	}
}
