package publisher

import (
	"context"
	"sort"
	"strings"
	"testing"
)

type memoryDeploymentBackend struct {
	objects       map[string]Object
	etags         map[string]string
	puts          []string
	invalidations [][]string
}

func (backend *memoryDeploymentBackend) PutObject(_ context.Context, key string, object Object) error {
	backend.objects[key] = object
	backend.ensureETags()
	backend.etags[key] = `"` + sha256Hex(object.Bytes) + `"`
	backend.puts = append(backend.puts, key)
	return nil
}

func (backend *memoryDeploymentBackend) GetObject(_ context.Context, key string) (Object, string, error) {
	object, exists := backend.objects[key]
	if !exists {
		return Object{}, "", ErrObjectNotFound
	}
	backend.ensureETags()
	if backend.etags[key] == "" {
		backend.etags[key] = `"` + sha256Hex(object.Bytes) + `"`
	}
	return object, backend.etags[key], nil
}

func (backend *memoryDeploymentBackend) PutObjectConditional(_ context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	backend.ensureETags()
	_, exists := backend.objects[key]
	if condition.IfNoneMatch && (exists || condition.IfMatchETag != "") {
		return "", ErrPreconditionFailed
	}
	if condition.IfMatchETag != "" && (!exists || backend.etags[key] != condition.IfMatchETag) {
		return "", ErrPreconditionFailed
	}
	object.Bytes = append([]byte(nil), object.Bytes...)
	backend.objects[key] = object
	etag := `"` + sha256Hex(object.Bytes) + `"`
	backend.etags[key] = etag
	return etag, nil
}

func (backend *memoryDeploymentBackend) ListKeys(_ context.Context, prefix string) ([]string, error) {
	var keys []string
	for key := range backend.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}

func (backend *memoryDeploymentBackend) DeleteObjects(_ context.Context, keys []string) error {
	for _, key := range keys {
		delete(backend.objects, key)
		if backend.etags != nil {
			delete(backend.etags, key)
		}
	}
	return nil
}

func (backend *memoryDeploymentBackend) Invalidate(_ context.Context, paths []string) (string, error) {
	backend.invalidations = append(backend.invalidations, append([]string(nil), paths...))
	return "memory-revalidation", nil
}

func (backend *memoryDeploymentBackend) HeadObject(_ context.Context, key string) (ObjectInfo, error) {
	object, exists := backend.objects[key]
	if !exists {
		return ObjectInfo{}, ErrObjectNotFound
	}
	metadata := make(map[string]string, len(object.Metadata)+1)
	for name, value := range object.Metadata {
		metadata[name] = value
	}
	if metadata["artifact-pages-sha256"] == "" {
		metadata["artifact-pages-sha256"] = sha256Hex(object.Bytes)
	}
	backend.ensureETags()
	if backend.etags[key] == "" {
		backend.etags[key] = `"` + sha256Hex(object.Bytes) + `"`
	}
	return ObjectInfo{
		ETag: backend.etags[key], Size: int64(len(object.Bytes)), ContentType: object.ContentType,
		ContentDisposition: object.ContentDisposition, ContentEncoding: object.ContentEncoding,
		CacheControl: object.Cache, Metadata: metadata,
	}, nil
}

var _ ConditionalObjectBackend = (*memoryDeploymentBackend)(nil)

func (backend *memoryDeploymentBackend) ensureETags() {
	if backend.etags == nil {
		backend.etags = make(map[string]string)
		for key, object := range backend.objects {
			backend.etags[key] = `"` + sha256Hex(object.Bytes) + `"`
		}
	}
}

func publicApplicationPuts(puts []string) []string {
	result := make([]string, 0, len(puts))
	for _, key := range puts {
		if !strings.HasPrefix(key, "_control/") {
			result = append(result, key)
		}
	}
	return result
}

func publicApplicationObjects(objects map[string]Object) map[string]Object {
	result := make(map[string]Object)
	for key, object := range objects {
		if !strings.HasPrefix(key, "_control/") {
			result[key] = object
		}
	}
	return result
}

func TestDeployAppUsesProviderNeutralBackend(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":             []byte("<script src=\"/assets/app-AbC123xY.js\"></script><script src=\"/assets/app.js\"></script>"),
		"assets/app-AbC123xY.js": []byte("console.log('hashed ready')"),
		"assets/app.js":          []byte("console.log('fixed ready')"),
	})
	backend := &memoryDeploymentBackend{objects: make(map[string]Object)}

	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("DeployApp() error = %v", err)
	}
	if result.FilesPublished != 3 || result.InvalidationID != "memory-revalidation" {
		t.Fatalf("DeployApp() = %+v, want three files and provider-neutral revalidation result", result)
	}
	appPuts := publicApplicationPuts(backend.puts)
	if len(appPuts) != 3 || appPuts[len(appPuts)-1] != "index.html" {
		t.Fatalf("upload order = %v, want index.html last", appPuts)
	}
	if got := backend.objects["assets/app-AbC123xY.js"].Cache; got != immutableCache {
		t.Errorf("hashed asset Cache-Control = %q, want %q", got, immutableCache)
	}
	if got := backend.objects["assets/app.js"].Cache; got != appShellCache {
		t.Errorf("fixed-name asset Cache-Control = %q, want %q", got, appShellCache)
	}
	if len(backend.invalidations) != 1 || strings.Join(backend.invalidations[0], ",") != "/index.html" {
		t.Errorf("revalidation paths = %v, want [/index.html]", backend.invalidations)
	}
}
