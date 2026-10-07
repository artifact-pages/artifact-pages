package bootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/config"
)

const repository = "artifact-pages/artifact-pages"

var checksumLine = regexp.MustCompile(`^([a-fA-F0-9]{64}) [ *]([^\s/\\]+)$`)
var officialAsset = regexp.MustCompile(`^https://api\.github\.com/repos/artifact-pages/artifact-pages/releases/assets/[0-9]+$`)

type Installer struct {
	Getenv   func(string) string
	Client   *http.Client
	CacheDir string // dependency injection in tests, never read from config.
	OS, Arch string
}

func (i Installer) Install(ctx context.Context, version string) (string, error) {
	if !config.ExactVersion(version) {
		return "", errors.New("CLI version must be exact MAJOR.MINOR.PATCH")
	}
	if i.Getenv == nil {
		i.Getenv = os.Getenv
	}
	if i.OS == "" {
		i.OS = runtime.GOOS
	}
	if i.Arch == "" {
		i.Arch = runtime.GOARCH
	}
	if (i.OS != "linux" && i.OS != "darwin") || (i.Arch != "amd64" && i.Arch != "arm64") {
		return "", fmt.Errorf("no released CLI for %s/%s", i.OS, i.Arch)
	}
	base, err := cacheBase(i.Getenv)
	if err != nil {
		return "", err
	}
	if i.CacheDir != "" {
		base = i.CacheDir
	}
	dir := filepath.Join(base, version, i.OS+"_"+i.Arch)
	asset := fmt.Sprintf("artifact-pages_v%s_%s_%s", version, i.OS, i.Arch)
	checksums := fmt.Sprintf("artifact-pages_v%s_checksums.txt", version)
	// Fetch current official checksums even for a cache hit: 0.x release tags can
	// be recreated, and a stale/tampered local binary must never run.
	data, err := i.download(ctx, version, checksums, 2<<20)
	if err != nil {
		return "", err
	}
	expected := ""
	for _, line := range strings.Split(string(data), "\n") {
		match := checksumLine.FindStringSubmatch(strings.TrimSpace(line))
		if len(match) == 3 && match[2] == asset {
			if expected != "" {
				return "", fmt.Errorf("duplicate checksum for %s", asset)
			}
			expected = strings.ToLower(match[1])
		}
	}
	if expected == "" {
		return "", fmt.Errorf("official checksums have no entry for %s", asset)
	}
	destination := filepath.Join(dir, "artifact-pages")
	if info, e := os.Lstat(destination); e == nil && info.Mode().IsRegular() && info.Size() <= 128<<20 {
		cached, e := os.ReadFile(destination)
		if e == nil && hash(cached) == expected {
			if e = os.Chmod(destination, 0755); e != nil {
				return "", e
			}
			return destination, nil
		}
	}
	data, err = i.download(ctx, version, asset, 128<<20)
	if err != nil {
		return "", err
	}
	if hash(data) != expected {
		return "", fmt.Errorf("checksum mismatch for %s", asset)
	}
	if err = os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}
	file, err := os.CreateTemp(dir, ".verified-cli-")
	if err != nil {
		return "", err
	}
	name := file.Name()
	defer os.Remove(name)
	_, err = file.Write(data)
	if err == nil {
		err = file.Chmod(0755)
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	if err = os.Rename(name, destination); err != nil {
		return "", err
	}
	return destination, nil
}
func hash(bytes []byte) string { sum := sha256.Sum256(bytes); return hex.EncodeToString(sum[:]) }

func (i Installer) request(ctx context.Context, location, accept, token string, limit int64) ([]byte, int, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, location, nil)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Accept", accept)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	}
	client := &http.Client{Timeout: 60 * time.Second}
	if i.Client != nil {
		*client = *i.Client
	}
	// Signed object-storage redirects must not receive a workflow token.
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		req.Header.Del("Authorization")
		if len(via) >= 10 {
			return errors.New("too many release redirects")
		}
		return nil
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, errors.New("official CLI release request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, response.StatusCode, nil
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, 200, errors.New("read official CLI release failed")
	}
	if int64(len(data)) > limit {
		return nil, 200, errors.New("official CLI release asset exceeds size limit")
	}
	return data, 200, nil
}
func (i Installer) download(ctx context.Context, version, asset string, limit int64) ([]byte, error) {
	location := "https://github.com/" + repository + "/releases/download/v" + version + "/" + asset
	bytes, status, err := i.request(ctx, location, "application/octet-stream", "", limit)
	if err != nil {
		return nil, err
	}
	if status == 200 {
		return bytes, nil
	}
	token := i.Getenv("ARTIFACT_PAGES_DOWNLOAD_TOKEN")
	if (status == 403 || status == 429) && token != "" {
		body, apiStatus, e := i.request(ctx, "https://api.github.com/repos/"+repository+"/releases/tags/"+url.PathEscape("v"+version), "application/vnd.github+json", token, 2<<20)
		if e != nil {
			return nil, e
		}
		if apiStatus == 200 {
			var release struct {
				Assets []struct {
					Name string `json:"name"`
					URL  string `json:"url"`
				} `json:"assets"`
			}
			if json.Unmarshal(body, &release) != nil {
				return nil, errors.New("invalid official release metadata")
			}
			for _, candidate := range release.Assets {
				if candidate.Name == asset {
					if !officialAsset.MatchString(candidate.URL) {
						return nil, errors.New("official release metadata has an invalid asset URL")
					}
					bytes, s, e := i.request(ctx, candidate.URL, "application/octet-stream", token, limit)
					if e != nil {
						return nil, e
					}
					if s == 200 {
						return bytes, nil
					}
					return nil, fmt.Errorf("official CLI asset %s returned HTTP %d", asset, s)
				}
			}
		}
	}
	return nil, fmt.Errorf("official CLI release v%s asset %s returned HTTP %d", version, asset, status)
}
