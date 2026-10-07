package bootstrap

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/artifact-pages/artifact-pages/cli/internal/version"
)

// A local official-release fixture serves an actual target CLI built from this
// tree. Resolution/download/checksum/re-exec and the target's compatibility gate
// run together; no source-test escape is used.
func TestOfficialFixtureReexecutesActualTargetAndKeepsCompatibilityChecks(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	root = filepath.Clean(filepath.Join(root, "..", "..", ".."))
	dir := t.TempDir()
	targetVersion := "0.1.99"
	if version.Product == targetVersion {
		targetVersion = "0.1.98"
	}
	versionPath := filepath.Join(root, "cli", "internal", "version", "version.go")
	body, err := os.ReadFile(versionPath)
	if err != nil {
		t.Fatal(err)
	}
	patched := strings.Replace(string(body), `const Product = "`+version.Product+`"`, `const Product = "`+targetVersion+`"`, 1)
	if patched == string(body) {
		t.Fatal("version fixture overlay was not applied")
	}
	patchedPath := filepath.Join(dir, "version.go")
	os.WriteFile(patchedPath, []byte(patched), 0600)
	overlay, _ := json.Marshal(map[string]any{"Replace": map[string]string{versionPath: patchedPath}})
	overlayPath := filepath.Join(dir, "overlay.json")
	os.WriteFile(overlayPath, overlay, 0600)
	binaryPath := filepath.Join(dir, "target")
	build := exec.Command("go", "build", "-overlay", overlayPath, "-o", binaryPath, "./cli/cmd/artifact-pages")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build local release target: %v %s", err, output)
	}
	binary, err := os.ReadFile(binaryPath)
	if err != nil {
		t.Fatal(err)
	}
	storage := filepath.Join(dir, "storage")
	configPath := filepath.Join(dir, "deployment.yaml")
	os.WriteFile(configPath, []byte("schemaVersion: 1\nprovider: local\nlocal: {root: "+storage+"}\ncli: {version: "+targetVersion+"}\nsites: {}\n"), 0600)
	app := filepath.Join(storage, "_control", "versions", "app.json")
	os.MkdirAll(filepath.Dir(app), 0755)
	os.WriteFile(app, []byte(`{"schemaVersion":1,"webVersion":"0.1.0","reads":{"registry":[2],"site-metadata":[2],"artifact-index":[2],"full-text-manifest":[2],"preview-catalog":[2],"preview-manifest":[2]}}`), 0600)
	metadataPath := filepath.Join(dir, "metadata.json")
	t.Setenv(MetadataEnv, metadataPath)
	t.Setenv(ResolvedEnv, "")
	t.Setenv(SkipEnv, "")
	t.Setenv(VersionEnv, "")
	t.Setenv(RangeEnv, ">=0.1.0 <0.2.0")
	t.Setenv(configVersionEnv, "")
	downloads := 0
	installer := Installer{CacheDir: filepath.Join(dir, "cache"), Client: &http.Client{Transport: transport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "github.com" || !strings.HasPrefix(r.URL.Path, "/artifact-pages/artifact-pages/releases/download/v"+targetVersion+"/") {
			t.Fatal("nonofficial fixture URL")
		}
		if strings.HasSuffix(r.URL.Path, "checksums.txt") {
			return response(200, hash(binary)+"  artifact-pages_v"+targetVersion+"_"+runtime.GOOS+"_"+runtime.GOARCH+"\n"), nil
		}
		downloads++
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(binary))}, nil
	})}}
	runner := Runner{Version: version.Product, Install: installer.Install}
	var stdout, stderr bytes.Buffer
	_, done, err := runner.Run(t.Context(), []string{"registry", "sync", "--config", configPath, "--format", "json"}, &stdout, &stderr)
	var exit *Error
	if !done || !errors.As(err, &exit) || exit.Code != 1 || downloads != 1 || !strings.Contains(stdout.String(), "cannot read") {
		t.Fatalf("done=%t exit=%v downloads=%d stdout=%s stderr=%s", done, err, downloads, stdout.String(), stderr.String())
	}
	var metadata Metadata
	data, _ := os.ReadFile(metadataPath)
	if err = json.Unmarshal(data, &metadata); err != nil || metadata.CLIVersion != targetVersion || metadata.ConfigVersion != targetVersion || !metadata.Resolved {
		t.Fatalf("%+v %v", metadata, err)
	}
	if _, err = os.Stat(filepath.Join(storage, "_indexes", "sites.json")); !os.IsNotExist(err) {
		t.Fatal("target bypassed storage compatibility check")
	}
}
