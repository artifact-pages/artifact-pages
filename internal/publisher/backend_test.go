package publisher

import (
	"context"
	"sort"
	"strings"
	"testing"
)

type memoryDeploymentBackend struct {
	objects       map[string]Object
	puts          []string
	invalidations [][]string
}

func (backend *memoryDeploymentBackend) PutObject(_ context.Context, key string, object Object) error {
	backend.objects[key] = object
	backend.puts = append(backend.puts, key)
	return nil
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
	return ObjectInfo{
		Size: int64(len(object.Bytes)), ContentType: object.ContentType,
		ContentDisposition: object.ContentDisposition, ContentEncoding: object.ContentEncoding,
		CacheControl: object.Cache, Metadata: metadata,
	}, nil
}

func TestDeployAppUsesProviderNeutralBackend(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("console.log('ready')"),
	})
	backend := &memoryDeploymentBackend{objects: make(map[string]Object)}

	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("DeployApp() error = %v", err)
	}
	if result.FilesPublished != 2 || result.InvalidationID != "memory-revalidation" {
		t.Fatalf("DeployApp() = %+v, want two files and provider-neutral revalidation result", result)
	}
	if len(backend.puts) != 2 || backend.puts[len(backend.puts)-1] != "index.html" {
		t.Fatalf("upload order = %v, want index.html last", backend.puts)
	}
	if got := backend.objects["assets/app.js"].Cache; got != immutableCache {
		t.Errorf("hashed asset Cache-Control = %q, want %q", got, immutableCache)
	}
	if len(backend.invalidations) != 1 || strings.Join(backend.invalidations[0], ",") != "/index.html" {
		t.Errorf("revalidation paths = %v, want [/index.html]", backend.invalidations)
	}
}
