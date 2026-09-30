package publisher

import (
	"archive/tar"
	"compress/gzip"
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
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/tasuku43/git-artifact-pages/cli/internal/githubrepo"
)

const (
	maxBundleBytes   = 512 << 20
	maxBundleEntries = 20000
	maxBundleFile    = 128 << 20
	appShellCache    = "no-cache, max-age=0, must-revalidate"
	immutableCache   = "public, max-age=31536000, immutable"
)

var versionLabel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`)
var releaseRepositoryOwnerPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+$`)

type releaseManifest struct {
	SchemaVersion int      `json:"schemaVersion"`
	Product       string   `json:"product"`
	Component     string   `json:"component"`
	Version       string   `json:"version"`
	Archive       string   `json:"archive"`
	ArchiveSHA256 string   `json:"archiveSha256"`
	SourceCommit  string   `json:"sourceCommit"`
	SourceDirty   bool     `json:"sourceDirty"`
	Files         []string `json:"files"`
}

type bundleFile struct {
	path string
	data []byte
}

type appBundle struct {
	manifest releaseManifest
	sha256   string
	files    []bundleFile
}

func loadAppBundle(archivePath string) (appBundle, error) {
	archivePath, err := filepath.Abs(archivePath)
	if err != nil {
		return appBundle{}, fmt.Errorf("resolve application archive path: %w", err)
	}
	archive, err := os.Open(archivePath)
	if err != nil {
		return appBundle{}, fmt.Errorf("open application archive: %w", err)
	}
	defer archive.Close()

	archiveInfo, err := archive.Stat()
	if err != nil {
		return appBundle{}, fmt.Errorf("stat application archive: %w", err)
	}
	if archiveInfo.Size() <= 0 || archiveInfo.Size() > maxBundleBytes {
		return appBundle{}, fmt.Errorf("application archive size must be between 1 byte and %d bytes", maxBundleBytes)
	}

	manifestData, err := os.ReadFile(archivePath + ".json")
	if err != nil {
		return appBundle{}, fmt.Errorf("read application release manifest: %w", err)
	}
	var manifest releaseManifest
	if err := json.Unmarshal(manifestData, &manifest); err != nil {
		return appBundle{}, fmt.Errorf("parse application release manifest: %w", err)
	}
	archiveName := filepath.Base(archivePath)
	if manifest.SchemaVersion != 1 || manifest.Product != "artifact-pages" || manifest.Component != "web" ||
		!versionLabel.MatchString(manifest.Version) || manifest.Archive != archiveName ||
		!regexp.MustCompile(`^[a-fA-F0-9]{64}$`).MatchString(manifest.ArchiveSHA256) || len(manifest.Files) == 0 {
		return appBundle{}, errors.New("application release manifest is invalid or does not match the archive")
	}

	checksumData, err := os.ReadFile(archivePath + ".sha256")
	if err != nil {
		return appBundle{}, fmt.Errorf("read application archive checksum: %w", err)
	}
	checksum := strings.Fields(string(checksumData))
	if len(checksum) != 2 || checksum[1] != archiveName || !regexp.MustCompile(`^[a-fA-F0-9]{64}$`).MatchString(checksum[0]) {
		return appBundle{}, errors.New("application archive checksum file is invalid")
	}

	hash := sha256.New()
	if _, err := io.Copy(hash, archive); err != nil {
		return appBundle{}, fmt.Errorf("hash application archive: %w", err)
	}
	archiveSHA256 := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(archiveSHA256, checksum[0]) || !strings.EqualFold(archiveSHA256, manifest.ArchiveSHA256) {
		return appBundle{}, errors.New("application archive SHA-256 does not match its manifest and checksum file")
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return appBundle{}, fmt.Errorf("rewind application archive: %w", err)
	}

	gzipReader, err := gzip.NewReader(archive)
	if err != nil {
		return appBundle{}, fmt.Errorf("open gzip application archive: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	files := make([]bundleFile, 0, len(manifest.Files))
	seen := make(map[string]struct{}, len(manifest.Files))
	var totalBytes int64
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return appBundle{}, fmt.Errorf("read application tar archive: %w", err)
		}
		relative, err := normalizeArchiveEntry(header.Name)
		if err != nil {
			return appBundle{}, err
		}
		if header.Typeflag == tar.TypeDir && relative == "" {
			continue
		}
		if header.Typeflag == tar.TypeDir {
			continue
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
			return appBundle{}, fmt.Errorf("unsupported entry type %d in application archive: %s", header.Typeflag, header.Name)
		}
		if _, exists := seen[relative]; exists {
			return appBundle{}, fmt.Errorf("duplicate file in application archive: %s", relative)
		}
		seen[relative] = struct{}{}
		if len(seen) > maxBundleEntries || header.Size < 0 || header.Size > maxBundleFile {
			return appBundle{}, errors.New("application archive exceeds file-count or per-file size limits")
		}
		totalBytes += header.Size
		if totalBytes > maxBundleBytes {
			return appBundle{}, errors.New("application archive expands beyond the allowed size")
		}
		contents, err := io.ReadAll(io.LimitReader(tarReader, header.Size+1))
		if err != nil {
			return appBundle{}, fmt.Errorf("read application archive file %s: %w", relative, err)
		}
		if int64(len(contents)) != header.Size {
			return appBundle{}, fmt.Errorf("application archive file has an invalid size: %s", relative)
		}
		files = append(files, bundleFile{path: relative, data: contents})
	}

	actualPaths := make([]string, 0, len(files))
	for _, file := range files {
		actualPaths = append(actualPaths, file.path)
	}
	manifestPaths, err := normalizeManifestFiles(manifest.Files)
	if err != nil {
		return appBundle{}, err
	}
	sort.Strings(actualPaths)
	if strings.Join(actualPaths, "\n") != strings.Join(manifestPaths, "\n") {
		return appBundle{}, errors.New("application archive contents do not match the release manifest")
	}
	if !hasPath(actualPaths, "index.html") || !hasAsset(actualPaths) {
		return appBundle{}, errors.New("application archive must contain index.html and at least one asset under assets/")
	}
	return appBundle{manifest: manifest, sha256: archiveSHA256, files: files}, nil
}

func resolveAppArchive(ctx context.Context, options AppDeployOptions) (string, func(), error) {
	if (options.ArchivePath == "") == (options.Version == "") {
		return "", nil, errors.New("choose exactly one of a local --archive or a published --version")
	}
	if options.ArchivePath != "" {
		return options.ArchivePath, nil, nil
	}
	if !versionLabel.MatchString(options.Version) {
		return "", nil, fmt.Errorf("invalid release version %q", options.Version)
	}
	repository := options.Repository
	if repository == "" {
		repository = "tasuku43/git-artifact-pages"
	}
	if !validReleaseRepository(repository) {
		return "", nil, errors.New("release repository must use owner/repository format")
	}

	archiveName := "artifact-pages-web-v" + options.Version + ".tar.gz"
	baseURL := "https://github.com/" + repository + "/releases/download/v" + url.PathEscape(options.Version) + "/"
	downloadRoot, err := os.MkdirTemp("", "artifact-pages-app-release-")
	if err != nil {
		return "", nil, fmt.Errorf("create temporary application download directory: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(downloadRoot) }
	archivePath := filepath.Join(downloadRoot, archiveName)
	for _, asset := range []struct {
		name  string
		limit int64
	}{
		{name: archiveName, limit: maxBundleBytes},
		{name: archiveName + ".json", limit: 4 << 20},
		{name: archiveName + ".sha256", limit: 4096},
	} {
		contents, err := downloadReleaseAsset(ctx, baseURL+url.PathEscape(asset.name), asset.limit)
		if err != nil {
			cleanup()
			return "", nil, err
		}
		if err := os.WriteFile(filepath.Join(downloadRoot, asset.name), contents, 0o600); err != nil {
			cleanup()
			return "", nil, fmt.Errorf("write downloaded release asset %s: %w", asset.name, err)
		}
	}
	return archivePath, cleanup, nil
}

func validReleaseRepository(repository string) bool {
	parts := strings.Split(repository, "/")
	return len(parts) == 2 && releaseRepositoryOwnerPattern.MatchString(parts[0]) && githubrepo.ValidRepositoryName(parts[1])
}

func downloadReleaseAsset(ctx context.Context, assetURL string, maxBytes int64) ([]byte, error) {
	parsed, err := url.Parse(assetURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return nil, fmt.Errorf("release asset URL must use HTTPS: %s", assetURL)
	}
	client := &http.Client{
		Timeout: 2 * time.Minute,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 8 || request.URL.Scheme != "https" {
				return errors.New("release download redirected to an unsupported URL")
			}
			return nil
		},
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create release download request: %w", err)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("download release asset %s: %w", parsed.EscapedPath(), err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release asset download returned HTTP %d for %s", response.StatusCode, parsed.EscapedPath())
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read release asset %s: %w", parsed.EscapedPath(), err)
	}
	if int64(len(contents)) > maxBytes {
		return nil, fmt.Errorf("release asset %s exceeds the %d-byte download limit", parsed.EscapedPath(), maxBytes)
	}
	return contents, nil
}

func normalizeArchiveEntry(value string) (string, error) {
	if strings.Contains(value, `\`) || path.IsAbs(value) {
		return "", fmt.Errorf("unsafe path in application archive: %q", value)
	}
	value = strings.TrimSuffix(value, "/")
	if value == "" || value == "." || value == "./" {
		return "", nil
	}
	if strings.HasPrefix(value, "./") {
		value = strings.TrimPrefix(value, "./")
	}
	segments := strings.Split(value, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", fmt.Errorf("unsafe path in application archive: %q", value)
		}
	}
	if segments[0] == "_indexes" || segments[0] == "_artifacts" || segments[0] == "_previews" || segments[0] == "_control" {
		return "", fmt.Errorf("application archive must not contain content- or control-plane files: %q", value)
	}
	return strings.Join(segments, "/"), nil
}

func normalizeManifestFiles(files []string) ([]string, error) {
	paths := make([]string, 0, len(files))
	seen := make(map[string]struct{}, len(files))
	for _, file := range files {
		normalized, err := normalizeArchiveEntry(file)
		if err != nil || normalized == "" {
			return nil, fmt.Errorf("invalid path in application release manifest: %q", file)
		}
		if _, exists := seen[normalized]; exists {
			return nil, fmt.Errorf("duplicate path in application release manifest: %s", normalized)
		}
		seen[normalized] = struct{}{}
		paths = append(paths, normalized)
	}
	sort.Strings(paths)
	return paths, nil
}

func hasPath(paths []string, value string) bool {
	for _, item := range paths {
		if item == value {
			return true
		}
	}
	return false
}

func hasAsset(paths []string) bool {
	for _, item := range paths {
		if strings.HasPrefix(item, "assets/") {
			return true
		}
	}
	return false
}
