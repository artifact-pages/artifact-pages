package publisher

import (
	"bytes"
	"context"
	"testing"
)

func TestLoadAppBundleCapturesDigestUsedForHEADAndPUT(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":       []byte("<main>digest reuse</main>"),
		"assets/app.js":    []byte("window.app = true;"),
		"assets/theme.css": []byte("body { color: #123; }"),
	})
	bundle, err := loadAppBundle(archive)
	if err != nil {
		t.Fatalf("loadAppBundle() error = %v", err)
	}
	if len(bundle.files) != 3 {
		t.Fatalf("bundle file count = %d, want 3", len(bundle.files))
	}

	backend := newAppCachePublishBackend()
	for _, file := range bundle.files {
		wantDigest := sha256Hex(file.data)
		if file.sha256 != wantDigest {
			t.Fatalf("captured digest for %s = %q, want %q", file.path, file.sha256, wantDigest)
		}
		info := ObjectInfo{
			Size: int64(len(file.data)), ContentType: contentType(file.path),
			CacheControl: appFileCacheControl(file.path),
			Metadata: map[string]string{
				"artifact-pages-sha256":        file.sha256,
				"artifact-pages-version":       bundle.manifest.Version,
				"artifact-pages-source-commit": bundle.manifest.SourceCommit,
			},
		}
		if !appObjectMatchesBundle(info, file, bundle.manifest) {
			t.Errorf("HEAD metadata for %s did not match the captured bundle entry", file.path)
		}
		wrongDigestEntry := file
		wrongDigestEntry.sha256 = "different-captured-digest"
		if appObjectMatchesBundle(info, wrongDigestEntry, bundle.manifest) {
			t.Errorf("HEAD comparison for %s ignored the bundle entry's captured digest", file.path)
		}
	}

	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("DeployApp() error = %v", err)
	}
	if result.FilesPublished != len(bundle.files) {
		t.Fatalf("DeployApp() published %d files, want %d", result.FilesPublished, len(bundle.files))
	}
	for _, file := range bundle.files {
		object, _, err := backend.store.objects.GetObject(context.Background(), file.path)
		if err != nil {
			t.Fatalf("read uploaded object %s: %v", file.path, err)
		}
		if !bytes.Equal(object.Bytes, file.data) || object.Metadata["artifact-pages-sha256"] != file.sha256 {
			t.Errorf("uploaded object %s body/digest differs from the captured bundle entry", file.path)
		}
		if object.ContentType != contentType(file.path) || object.Cache != appFileCacheControl(file.path) ||
			object.Metadata["artifact-pages-version"] != bundle.manifest.Version ||
			object.Metadata["artifact-pages-source-commit"] != bundle.manifest.SourceCommit {
			t.Errorf("uploaded object %s metadata/policy = %+v; want captured version, provenance, and HTTP policy", file.path, object)
		}
	}
}
