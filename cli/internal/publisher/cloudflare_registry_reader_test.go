package publisher

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCloudflareRegistryReadUsesSeparateReadOnlyIdentity(t *testing.T) {
	type observedRequest struct {
		method        string
		path          string
		authorization string
	}
	var requests []observedRequest
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		requests = append(requests, observedRequest{
			method: request.Method, path: request.URL.Path, authorization: request.Header.Get("Authorization"),
		})
		if request.Method == http.MethodPut {
			if _, err := io.Copy(io.Discard, request.Body); err != nil {
				t.Errorf("read uploaded object: %v", err)
			}
			writer.Header().Set("ETag", `"write-etag"`)
			writer.WriteHeader(http.StatusOK)
			return
		}
		body := `{"sites":[]}`
		if strings.HasSuffix(request.URL.Path, "/_indexes/sre/index.json") {
			body = `{"site":"sre"}`
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Content-Length", fmt.Sprint(len(body)))
		writer.Header().Set("ETag", `"read-etag"`)
		_, _ = io.WriteString(writer, body)
	}))
	defer server.Close()

	deploymentBackend, err := NewCloudflareBackend(context.Background(), CloudflareOptions{
		AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
		ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
		R2Endpoint: server.URL, APIBaseURL: server.URL + "/client/v4",
		AccessKeyID: "site-writer", SecretKey: "site-writer-secret",
		RegistryReaderAccessKeyID: "registry-reader", RegistryReaderSecretKey: "registry-reader-secret",
	})
	if err != nil {
		t.Fatalf("NewCloudflareBackend(): %v", err)
	}
	backend, ok := deploymentBackend.(*cloudflareBackend)
	if !ok {
		t.Fatalf("NewCloudflareBackend() type = %T, want *cloudflareBackend", deploymentBackend)
	}

	if _, _, err := backend.GetObject(context.Background(), "_indexes/sites.json"); err != nil {
		t.Fatalf("GetObject(registry): %v", err)
	}
	if _, _, err := backend.GetObject(context.Background(), appVersionsKey); err != nil {
		t.Fatalf("GetObject(deployed app versions): %v", err)
	}
	if _, _, err := backend.GetObject(context.Background(), "_indexes/sre/index.json"); err != nil {
		t.Fatalf("GetObject(site index): %v", err)
	}
	if err := backend.PutObject(context.Background(), "_indexes/sites.json", Object{Bytes: []byte(`{"sites":["sre"]}`), ContentType: "application/json"}); err != nil {
		t.Fatalf("PutObject(registry): %v", err)
	}

	want := []struct {
		method string
		path   string
		key    string
	}{
		{http.MethodGet, "/artifact-pages/_indexes/sites.json", "registry-reader"},
		{http.MethodGet, "/artifact-pages/" + appVersionsKey, "registry-reader"},
		{http.MethodGet, "/artifact-pages/_indexes/sre/index.json", "site-writer"},
		{http.MethodPut, "/artifact-pages/_indexes/sites.json", "site-writer"},
	}
	if len(requests) != len(want) {
		t.Fatalf("R2 requests = %#v, want %d requests", requests, len(want))
	}
	for index, expected := range want {
		got := requests[index]
		if got.method != expected.method || got.path != expected.path {
			t.Errorf("request %d = %s %s, want %s %s", index, got.method, got.path, expected.method, expected.path)
		}
		if !strings.Contains(got.authorization, "Credential="+expected.key+"/") {
			t.Errorf("request %d credential = %q, want %q", index, got.authorization, expected.key)
		}
	}
}
