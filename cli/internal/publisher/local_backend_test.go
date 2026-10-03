package publisher

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestDirectoryBackendProjectsStaticObjectsLocally(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".local", "storage")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := backend.PutObject(ctx, "_artifacts/sre/overview.html", Object{
		Bytes: []byte("<h1>Overview</h1>"), ContentType: "text/html; charset=utf-8", Cache: "no-store",
	}); err != nil {
		t.Fatalf("PutObject(artifact) error = %v", err)
	}
	if err := backend.PutObject(ctx, "_indexes/sre/meta.json", Object{Bytes: []byte(`{"site":"sre"}`)}); err != nil {
		t.Fatalf("PutObject(index) error = %v", err)
	}
	keys, err := backend.ListKeys(ctx, "_artifacts/sre/")
	if err != nil {
		t.Fatalf("ListKeys() error = %v", err)
	}
	if !reflect.DeepEqual(keys, []string{"_artifacts/sre/overview.html"}) {
		t.Fatalf("ListKeys() = %v, want one site artifact", keys)
	}
	keys, err = backend.ListKeys(ctx, "_artifacts/sre/overview.html")
	if err != nil || !reflect.DeepEqual(keys, []string{"_artifacts/sre/overview.html"}) {
		t.Fatalf("ListKeys(exact key prefix) = %v, err=%v, want the exact object", keys, err)
	}
	contents, err := os.ReadFile(filepath.Join(root, "_artifacts", "sre", "overview.html"))
	if err != nil || string(contents) != "<h1>Overview</h1>" {
		t.Fatalf("local artifact = %q, err=%v", contents, err)
	}
	if _, err := backend.Invalidate(ctx, []string{"/_indexes/sre/meta.json"}); err != nil {
		t.Fatalf("Invalidate() error = %v, want local no-op", err)
	}
	if err := backend.DeleteObjects(ctx, []string{"_artifacts/sre/overview.html"}); err != nil {
		t.Fatalf("DeleteObjects() error = %v", err)
	}
	keys, err = backend.ListKeys(ctx, "_artifacts/sre/")
	if err != nil || len(keys) != 0 {
		t.Fatalf("ListKeys() after delete = %v, err=%v", keys, err)
	}
}

func TestDirectoryBackendPersistsPrivateControlMetadataForHeadAndCAS(t *testing.T) {
	root := filepath.Join(t.TempDir(), "storage")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	key := "_control/publish-state/sre.json.gz"
	body := []byte("compressed private state bytes")
	digest := sha256Hex(body)
	object := Object{
		Bytes: body, ContentType: "application/octet-stream", Cache: "no-store",
		Metadata: map[string]string{
			"artifact-pages-site": "sre", "artifact-pages-sha256": digest,
			"artifact-pages-publish-state-schema": "1", "artifact-pages-publish-input-root": strings.Repeat("a", 64),
			"artifact-pages-publish-pending": "false",
		},
	}
	etag, err := backend.PutObjectConditional(context.Background(), key, object, ObjectCondition{IfNoneMatch: true})
	if err != nil {
		t.Fatalf("PutObjectConditional() error = %v", err)
	}
	cleanupKeys, err := listSiteKeys(context.Background(), backend, "sre")
	if err != nil || !reflect.DeepEqual(cleanupKeys, []string{key}) {
		t.Fatalf("listSiteKeys() = %v, err=%v, want the exact private state key", cleanupKeys, err)
	}
	info, err := backend.HeadObject(context.Background(), key)
	if err != nil {
		t.Fatalf("HeadObject() error = %v", err)
	}
	if info.ETag != etag || info.Size != int64(len(body)) || info.ContentType != object.ContentType || info.CacheControl != object.Cache || info.ContentEncoding != "" || info.Metadata["artifact-pages-publish-input-root"] != strings.Repeat("a", 64) || info.Metadata["artifact-pages-sha256"] != digest {
		t.Fatalf("HeadObject() = %+v, want persisted control metadata and ETag %q", info, etag)
	}
	got, gotETag, err := backend.GetObject(context.Background(), key)
	if err != nil {
		t.Fatalf("GetObject() error = %v", err)
	}
	if gotETag != etag || !bytes.Equal(got.Bytes, body) || got.Metadata["artifact-pages-publish-pending"] != "false" {
		t.Fatalf("GetObject() = %+v, ETag %q", got, gotETag)
	}
	metadataPath, err := backend.storedObjectMetadataPath(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.DeleteObjects(context.Background(), []string{key}); err != nil {
		t.Fatalf("DeleteObjects() error = %v", err)
	}
	if _, err := os.Stat(metadataPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("private metadata sidecar still exists after object deletion: %v", err)
	}
}

func TestDirectoryBackendRejectsTraversalAndSymlinks(t *testing.T) {
	root := filepath.Join(t.TempDir(), "storage")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := backend.PutObject(context.Background(), "../escape", Object{Bytes: []byte("no")}); err == nil {
		t.Fatal("PutObject(traversal) succeeded, want rejection")
	}
	outside := t.TempDir()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := backend.PutObject(context.Background(), "link/escape", Object{Bytes: []byte("no")}); err == nil {
		t.Fatal("PutObject(symlink path) succeeded, want rejection")
	}
	if _, err := os.Stat(filepath.Join(outside, "escape")); !os.IsNotExist(err) {
		t.Fatalf("symlink target was modified: err=%v", err)
	}
}

func TestDirectoryBackendSiteLockCoordinatesAcrossProcesses(t *testing.T) {
	root := filepath.Join(t.TempDir(), "storage")
	acquiredPath := filepath.Join(t.TempDir(), "acquired")
	releasePath := filepath.Join(t.TempDir(), "release")

	command := exec.Command(os.Args[0], "-test.run=^TestDirectoryBackendLockHelperProcess$")
	command.Env = append(os.Environ(),
		"ARTIFACT_PAGES_LOCAL_LOCK_HELPER=hold",
		"ARTIFACT_PAGES_LOCAL_LOCK_ROOT="+root,
		"ARTIFACT_PAGES_LOCAL_LOCK_ACQUIRED="+acquiredPath,
		"ARTIFACT_PAGES_LOCAL_LOCK_RELEASE="+releasePath,
	)
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatalf("start lock helper process: %v", err)
	}
	t.Cleanup(func() {
		_ = os.WriteFile(releasePath, []byte("release"), 0o600)
		_ = command.Process.Kill()
		_ = command.Wait()
	})
	waitForLocalLockHelperFile(t, acquiredPath)

	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	manager := SiteLockManager{Backend: backend, WaitLimit: 80 * time.Millisecond, PollPeriod: 5 * time.Millisecond}
	if _, release, err := manager.Acquire(context.Background(), "sre"); err == nil {
		_ = release()
		t.Fatal("second process acquired the held site lock")
	} else if !strings.Contains(err.Error(), "timed out waiting for site") {
		t.Fatalf("second process acquire error = %v, want bounded timeout", err)
	}

	if err := os.WriteFile(releasePath, []byte("release"), 0o600); err != nil {
		t.Fatalf("release lock helper: %v", err)
	}
	if err := command.Wait(); err != nil {
		t.Fatalf("lock helper process failed: %v\n%s", err, output.String())
	}
	_, release, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("acquire after other process released: %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release after cross-process check: %v", err)
	}
}

func TestDirectoryBackendLockHelperProcess(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_LOCAL_LOCK_HELPER") != "hold" {
		return
	}
	root := os.Getenv("ARTIFACT_PAGES_LOCAL_LOCK_ROOT")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	_, release, err := (SiteLockManager{Backend: backend}).Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(os.Getenv("ARTIFACT_PAGES_LOCAL_LOCK_ACQUIRED"), []byte("acquired"), 0o600); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(os.Getenv("ARTIFACT_PAGES_LOCAL_LOCK_RELEASE")); err == nil {
			if err := release(); err != nil {
				t.Fatal(err)
			}
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	_ = release()
	t.Fatal("timed out waiting for parent release signal")
}

func waitForLocalLockHelperFile(t *testing.T, filePath string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filePath); err == nil {
			return
		} else if !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("check lock helper readiness: %v", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("lock helper did not acquire site lock before timeout")
}

func TestDirectoryBackendReportsSearchBlobMetadataAsPublished(t *testing.T) {
	backend, err := NewDirectoryBackend(filepath.Join(t.TempDir(), "storage"))
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	data := []byte("gzip bytes")
	desired := desiredSiteObject{
		key: "_indexes/sre/search/leaf-0a.gz", data: data, digest: sha256Hex(data),
		object: Object{ContentType: "application/octet-stream", ContentDisposition: "inline", Cache: immutableCache},
	}
	if err := backend.PutObject(ctx, desired.key, Object{Bytes: data}); err != nil {
		t.Fatal(err)
	}
	info, err := backend.HeadObject(ctx, desired.key)
	if err != nil {
		t.Fatal(err)
	}
	// Without this, every site publish re-uploads all search blobs to local storage.
	if !siteObjectMetadataMatches(info, desired) {
		t.Fatalf("HeadObject(search blob) = type %q cache %q, want it to match the published object", info.ContentType, info.CacheControl)
	}
}

func TestDirectoryBackendRecoversMetadataJournalAcrossBodyRename(t *testing.T) {
	root := filepath.Join(t.TempDir(), "storage")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	key := "_control/publish-state/sre.json.gz"
	oldBody := []byte("old compressed state")
	oldObject := Object{
		Bytes: oldBody, ContentType: "application/octet-stream", Cache: "no-store",
		Metadata: map[string]string{"artifact-pages-publish-state-schema": "1", "artifact-pages-sha256": sha256Hex(oldBody)},
	}
	if err := backend.PutObject(ctx, key, oldObject); err != nil {
		t.Fatal(err)
	}
	newBody := []byte("new compressed state")
	newObject := Object{
		Bytes: newBody, ContentType: "application/octet-stream", Cache: "no-store",
		Metadata: map[string]string{"artifact-pages-publish-state-schema": "1", "artifact-pages-sha256": sha256Hex(newBody)},
	}
	oldMetadata, err := backend.readStoredObjectMetadata(key, oldBody)
	if err != nil {
		t.Fatal(err)
	}
	previous := metadataVersion(oldMetadata)
	next := metadataVersionForObject(newObject)
	journal := localStoredObjectMetadata{
		ContentType: next.ContentType, ContentDisposition: next.ContentDisposition,
		ContentEncoding: next.ContentEncoding, CacheControl: next.CacheControl,
		Metadata: next.Metadata, BodySHA256: next.BodySHA256, Pending: true, Previous: &previous,
	}
	journalBytes, err := json.Marshal(journal)
	if err != nil {
		t.Fatal(err)
	}
	metadataPath, err := backend.storedObjectMetadataPath(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(metadataPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := atomicDeploymentWrite(metadataPath, journalBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	// A restart before the body rename selects the previous metadata version.
	restarted, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	oldInfo, err := restarted.HeadObject(ctx, key)
	if err != nil || oldInfo.Metadata["artifact-pages-publish-state-schema"] != "1" || oldInfo.Metadata["artifact-pages-sha256"] != sha256Hex(oldBody) {
		t.Fatalf("HEAD before body rename = %+v, %v; want old metadata", oldInfo, err)
	}

	// Simulate process death immediately after replacing object bytes but before
	// finalizing the sidecar: the journal must make the new state readable.
	bodyPath, err := restarted.objectPath(key)
	if err != nil {
		t.Fatal(err)
	}
	if err := atomicDeploymentWrite(bodyPath, newBody, 0o644); err != nil {
		t.Fatal(err)
	}
	restartedAfterRename, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	newInfo, err := restartedAfterRename.HeadObject(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	if newInfo.Metadata["artifact-pages-sha256"] != sha256Hex(newBody) {
		t.Fatalf("HEAD after body rename = %+v, want new body metadata", newInfo)
	}
	got, _, err := restartedAfterRename.GetObject(ctx, key)
	if err != nil || string(got.Bytes) != string(newBody) || got.Metadata["artifact-pages-sha256"] != sha256Hex(newBody) {
		t.Fatalf("GET after body rename = (%q, %+v), %v", got.Bytes, got.Metadata, err)
	}
}

func TestDirectoryBackendKeepsAFreshRootReadableAndControlPrivate(t *testing.T) {
	old := syscallUmask(0o022)
	defer syscallUmask(old)
	root := filepath.Join(t.TempDir(), "fresh", "storage")
	backend, err := NewDirectoryBackend(root)
	if err != nil {
		t.Fatal(err)
	}
	// A registry register on a fresh root starts with a conditional write.
	if _, err := backend.PutObjectConditional(context.Background(), "_indexes/sites.json", Object{Bytes: []byte(`{}`)}, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatalf("PutObjectConditional() error = %v", err)
	}
	for path, want := range map[string]os.FileMode{
		root:                            0o755,
		filepath.Join(root, "_indexes"): 0o755,
		filepath.Join(root, "_control"): 0o700,
	} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if got := info.Mode().Perm(); got != want {
			t.Errorf("mode of %s = %o, want %o", path, got, want)
		}
	}
}
