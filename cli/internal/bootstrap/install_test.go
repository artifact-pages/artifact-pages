package bootstrap

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type transport func(*http.Request) (*http.Response, error)

func (f transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func response(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

func TestCacheChecksOfficialChecksumAndRepairsTamper(t *testing.T) {
	binary := "verified binary"
	downloads, checks := 0, 0
	installer := Installer{Getenv: env(nil), CacheDir: t.TempDir(), OS: "linux", Arch: "amd64", Client: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "github.com" || !strings.HasPrefix(r.URL.Path, "/artifact-pages/artifact-pages/releases/download/v0.1.1/") || r.Header.Get("Authorization") != "" {
			t.Fatal(r.URL, r.Header)
		}
		if strings.HasSuffix(r.URL.Path, "checksums.txt") {
			checks++
			return response(200, hash([]byte(binary))+"  artifact-pages_v0.1.1_linux_amd64\n"), nil
		}
		downloads++
		return response(200, binary), nil
	})}}
	p, err := installer.Install(t.Context(), "0.1.1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = installer.Install(t.Context(), "0.1.1"); err != nil {
		t.Fatal(err)
	}
	if downloads != 1 || checks != 2 {
		t.Fatalf("%d %d", downloads, checks)
	}
	os.WriteFile(p, []byte("tampered"), 0700)
	if _, err = installer.Install(t.Context(), "0.1.1"); err != nil {
		t.Fatal(err)
	}
	bytes, _ := os.ReadFile(p)
	if string(bytes) != binary || downloads != 2 || checks != 3 {
		t.Fatalf("%s %d %d", bytes, downloads, checks)
	}
	// 0.x release recreation refreshes both checksum and binary.
	binary = "replacement official binary"
	if _, err = installer.Install(t.Context(), "0.1.1"); err != nil {
		t.Fatal(err)
	}
	bytes, _ = os.ReadFile(p)
	if string(bytes) != binary || downloads != 3 {
		t.Fatal(string(bytes), downloads)
	}
}
func TestDownloadTokenSeparationAndRateLimitRetry(t *testing.T) {
	for _, workflow := range []string{"", "workflow-only"} {
		t.Run(fmt.Sprint(workflow != ""), func(t *testing.T) {
			apiRequests := 0
			binary := "verified"
			asset := "artifact-pages_v0.1.1_linux_amd64"
			checksum := hash([]byte(binary)) + "  " + asset + "\n"
			installer := Installer{Getenv: env(map[string]string{"ARTIFACT_PAGES_DOWNLOAD_TOKEN": workflow, "GITHUB_TOKEN": "private-config-token", "GH_TOKEN": "other-private-token"}), CacheDir: t.TempDir(), OS: "linux", Arch: "amd64", Client: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == "github.com" {
					if r.Header.Get("Authorization") != "" {
						t.Fatal("token sent to anonymous release URL")
					}
					return response(429, ""), nil
				}
				if r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer workflow-only" {
					t.Fatal("private token leaked or invalid API host")
				}
				apiRequests++
				if strings.Contains(r.URL.Path, "/releases/tags/") {
					return response(200, `{"assets":[{"name":"`+asset+`","url":"https://api.github.com/repos/artifact-pages/artifact-pages/releases/assets/1"},{"name":"artifact-pages_v0.1.1_checksums.txt","url":"https://api.github.com/repos/artifact-pages/artifact-pages/releases/assets/2"}]}`), nil
				}
				if strings.HasSuffix(r.URL.Path, "/2") {
					return response(200, checksum), nil
				}
				return response(200, binary), nil
			})}}
			_, err := installer.Install(t.Context(), "0.1.1")
			if workflow == "" {
				if err == nil || apiRequests != 0 {
					t.Fatal(err, apiRequests)
				}
			} else if err != nil || apiRequests != 4 {
				t.Fatal(err, apiRequests)
			}
		})
	}
}
func TestInstallerFailsClosedOnMismatchAndForeignAsset(t *testing.T) {
	for _, foreign := range []bool{false, true} {
		installer := Installer{Getenv: env(map[string]string{"ARTIFACT_PAGES_DOWNLOAD_TOKEN": "workflow"}), CacheDir: t.TempDir(), OS: "darwin", Arch: "arm64", Client: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
			if foreign {
				if r.URL.Host == "github.com" {
					return response(403, ""), nil
				}
				if r.URL.Host != "api.github.com" {
					t.Fatal("foreign binary request")
				}
				return response(200, `{"assets":[{"name":"artifact-pages_v0.1.1_checksums.txt","url":"https://evil.example/assets/1"}]}`), nil
			}
			if strings.HasSuffix(r.URL.Path, "checksums.txt") {
				return response(200, strings.Repeat("a", 64)+"  artifact-pages_v0.1.1_darwin_arm64\n"), nil
			}
			return response(200, "wrong binary"), nil
		})}}
		if p, err := installer.Install(t.Context(), "0.1.1"); err == nil || p != "" {
			t.Fatal(p, err)
		}
	}
}

func TestCacheSymlinkNeverRunsOrMutatesExternalFile(t *testing.T) {
	root := t.TempDir()
	destination := filepath.Join(root, "0.1.1", "linux_amd64", "artifact-pages")
	os.MkdirAll(filepath.Dir(destination), 0755)
	external := filepath.Join(t.TempDir(), "outside")
	os.WriteFile(external, []byte("outside bytes"), 0600)
	os.Symlink(external, destination)
	verified := "official bytes"
	i := Installer{Getenv: env(nil), CacheDir: root, OS: "linux", Arch: "amd64", Client: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		if strings.HasSuffix(r.URL.Path, "checksums.txt") {
			return response(200, hash([]byte(verified))+"  artifact-pages_v0.1.1_linux_amd64\n"), nil
		}
		return response(200, verified), nil
	})}}
	p, err := i.Install(t.Context(), "0.1.1")
	if err != nil {
		t.Fatal(err)
	}
	info, _ := os.Lstat(p)
	if !info.Mode().IsRegular() {
		t.Fatal("unverified symlink retained")
	}
	data, _ := os.ReadFile(external)
	if string(data) != "outside bytes" {
		t.Fatal("external target modified")
	}
}
