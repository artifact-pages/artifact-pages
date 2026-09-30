package publisher

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
)

func TestLocalGCSBackendObjectAndConditionalContracts(t *testing.T) {
	harness := newLocalGCSTestServer(t)
	defer harness.server.Close()
	backend := localGCSBackendForTest(t, harness.server)
	key := "site/reports/a #+ 日本.html"
	wantObject := Object{
		Bytes: []byte("<h1>hello</h1>"), ContentType: "text/html; charset=utf-8",
		ContentDisposition: "inline", ContentEncoding: "gzip", Cache: "public, max-age=60",
		Metadata: map[string]string{"build": "unit"},
	}

	firstGeneration, err := backend.PutObjectConditional(context.Background(), key, wantObject, ObjectCondition{IfNoneMatch: true})
	if err != nil {
		t.Fatalf("initial conditional write: %v", err)
	}
	if !strings.HasPrefix(firstGeneration, gcsLocalGenerationPrefix) {
		t.Fatalf("generation token = %q, want local GCS generation token", firstGeneration)
	}
	if _, err := backend.PutObjectConditional(context.Background(), key, wantObject, ObjectCondition{IfNoneMatch: true}); err != ErrPreconditionFailed {
		t.Fatalf("duplicate create error = %v, want ErrPreconditionFailed", err)
	}
	if _, err := backend.PutObjectConditional(context.Background(), key, wantObject, ObjectCondition{IfMatchETag: gcsLocalGenerationPrefix + "999"}); err != ErrPreconditionFailed {
		t.Fatalf("stale generation error = %v, want ErrPreconditionFailed", err)
	}

	info, err := backend.HeadObject(context.Background(), key)
	if err != nil {
		t.Fatalf("HeadObject(): %v", err)
	}
	if info.ETag != firstGeneration || info.Size != int64(len(wantObject.Bytes)) || info.ContentType != wantObject.ContentType || info.ContentDisposition != wantObject.ContentDisposition || info.ContentEncoding != wantObject.ContentEncoding || info.CacheControl != wantObject.Cache || info.Metadata["build"] != "unit" {
		t.Fatalf("HeadObject() = %+v, does not preserve object metadata", info)
	}

	gotObject, gotGeneration, err := backend.GetObject(context.Background(), key)
	if err != nil {
		t.Fatalf("GetObject(): %v", err)
	}
	if gotGeneration != firstGeneration || !bytes.Equal(gotObject.Bytes, wantObject.Bytes) || gotObject.ContentType != wantObject.ContentType || gotObject.Cache != wantObject.Cache || gotObject.Metadata["build"] != "unit" {
		t.Fatalf("GetObject() = %+v, generation %q; want uploaded bytes and metadata", gotObject, gotGeneration)
	}

	updated := wantObject
	updated.Bytes = []byte("<h1>updated</h1>")
	secondGeneration, err := backend.PutObjectConditional(context.Background(), key, updated, ObjectCondition{IfMatchETag: firstGeneration})
	if err != nil {
		t.Fatalf("generation-matched update: %v", err)
	}
	if secondGeneration == firstGeneration {
		t.Fatalf("update generation = %q, must change after replacement", secondGeneration)
	}
	if _, _, err := backend.GetObject(context.Background(), "missing/key"); err != ErrObjectNotFound {
		t.Fatalf("missing read error = %v, want ErrObjectNotFound", err)
	}
}

func TestLocalGCSBackendRejectsObjectsBeyondReadLimit(t *testing.T) {
	harness := newLocalGCSTestServer(t)
	defer harness.server.Close()
	backend := localGCSBackendForTest(t, harness.server)
	key := "site/large-object"
	contents := make([]byte, gcsLocalMaxObjectBytes+1)
	harness.state.objects[key] = localGCSTestObject{
		metadata: gcsObjectMetadata{
			Name: key, Generation: "1", Size: strconv.Itoa(len(contents)), ContentType: "application/octet-stream",
		},
		bytes: contents,
	}

	if object, _, err := backend.GetObject(context.Background(), key); err == nil {
		t.Fatalf("GetObject() returned %d bytes without error; want an explicit read-limit error", len(object.Bytes))
	} else if !strings.Contains(err.Error(), "local adapter read limit") {
		t.Fatalf("GetObject() error = %v, want a local adapter read-limit error", err)
	}
}

func TestLocalGCSBackendListsAllPagesAndRejectsOutOfPrefixKeys(t *testing.T) {
	harness := newLocalGCSTestServer(t)
	defer harness.server.Close()
	backend := localGCSBackendForTest(t, harness.server)
	for _, key := range []string{"site/a", "site/b", "site/c", "site-long/outside"} {
		if err := backend.PutObject(context.Background(), key, Object{Bytes: []byte(key), ContentType: "text/plain"}); err != nil {
			t.Fatalf("PutObject(%q): %v", key, err)
		}
	}
	keys, err := backend.ListKeys(context.Background(), "site/")
	if err != nil {
		t.Fatalf("ListKeys(): %v", err)
	}
	if got, want := strings.Join(keys, ","), "site/a,site/b,site/c"; got != want {
		t.Fatalf("ListKeys() = %q, want %q", got, want)
	}
}

func TestLocalGCSBackendBatchesDeleteRequests(t *testing.T) {
	harness := newLocalGCSTestServer(t)
	defer harness.server.Close()
	backend := localGCSBackendForTest(t, harness.server)
	keys := make([]string, 201)
	for index := range keys {
		keys[index] = fmt.Sprintf("site/object-%03d", index)
		if err := backend.PutObject(context.Background(), keys[index], Object{Bytes: []byte("value")}); err != nil {
			t.Fatalf("PutObject(%q): %v", keys[index], err)
		}
	}
	if err := backend.DeleteObjects(context.Background(), keys); err != nil {
		t.Fatalf("DeleteObjects(): %v", err)
	}
	if got, want := harness.state.batchRequests, 3; got != want {
		t.Fatalf("batch request count = %d, want %d", got, want)
	}
	for _, key := range keys {
		if _, err := backend.HeadObject(context.Background(), key); err != ErrObjectNotFound {
			t.Fatalf("HeadObject(%q) after delete error = %v, want ErrObjectNotFound", key, err)
		}
	}
}

func TestNewLocalGCSBackendRejectsNonLocalAndInvalidEndpoints(t *testing.T) {
	for _, endpoint := range []string{"", "https://localhost:4443", "http://example.com:4443", "http://localhost:4443/path", "http://user:pass@localhost:4443"} {
		if _, err := NewLocalGCSBackend(endpoint, "bucket"); err == nil {
			t.Errorf("NewLocalGCSBackend(%q) error = nil, want endpoint error", endpoint)
		}
	}
	if _, err := NewLocalGCSBackend("http://127.0.0.1:4443", " "); err == nil {
		t.Fatal("NewLocalGCSBackend(blank bucket) error = nil, want bucket error")
	}
}

func localGCSBackendForTest(t *testing.T, server *httptest.Server) ConditionalObjectBackend {
	t.Helper()
	backend, err := NewLocalGCSBackend(server.URL, "artifact-pages")
	if err != nil {
		t.Fatal(err)
	}
	return backend
}

type localGCSTestObject struct {
	metadata gcsObjectMetadata
	bytes    []byte
}

type localGCSTestServer struct {
	t              *testing.T
	mu             sync.Mutex
	objects        map[string]localGCSTestObject
	nextGeneration int64
	batchRequests  int
}

type localGCSTestHarness struct {
	server *httptest.Server
	state  *localGCSTestServer
}

func newLocalGCSTestServer(t *testing.T) *localGCSTestHarness {
	state := &localGCSTestServer{t: t, objects: make(map[string]localGCSTestObject)}
	return &localGCSTestHarness{server: httptest.NewServer(http.HandlerFunc(state.serveHTTP)), state: state}
}

func (server *localGCSTestServer) serveHTTP(writer http.ResponseWriter, request *http.Request) {
	switch {
	case request.Method == http.MethodPost && request.URL.Path == "/upload/storage/v1/b/artifact-pages/o":
		server.upload(writer, request)
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/storage/v1/b/artifact-pages/o/"):
		key := decodeObjectKey(request.URL.EscapedPath(), "/storage/v1/b/artifact-pages/o/")
		server.read(writer, request, key)
	case request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/download/storage/v1/b/artifact-pages/o/"):
		key := decodeObjectKey(request.URL.EscapedPath(), "/download/storage/v1/b/artifact-pages/o/")
		server.read(writer, request, key)
	case request.Method == http.MethodGet && request.URL.Path == "/storage/v1/b/artifact-pages/o":
		server.list(writer, request)
	case request.Method == http.MethodPost && request.URL.Path == "/batch/storage/v1":
		server.batchDelete(writer, request)
	default:
		http.NotFound(writer, request)
	}
}

func (server *localGCSTestServer) upload(writer http.ResponseWriter, request *http.Request) {
	mediaType, params, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/related" {
		server.t.Errorf("upload Content-Type = %q, want multipart/related", request.Header.Get("Content-Type"))
		http.Error(writer, "bad content type", http.StatusBadRequest)
		return
	}
	reader := multipart.NewReader(request.Body, params["boundary"])
	metadataPart, err := reader.NextPart()
	if err != nil {
		http.Error(writer, "missing metadata", http.StatusBadRequest)
		return
	}
	var metadata gcsObjectMetadata
	if err := json.NewDecoder(metadataPart).Decode(&metadata); err != nil {
		http.Error(writer, "bad metadata", http.StatusBadRequest)
		return
	}
	mediaPart, err := reader.NextPart()
	if err != nil {
		http.Error(writer, "missing media", http.StatusBadRequest)
		return
	}
	contents, err := io.ReadAll(mediaPart)
	if err != nil {
		http.Error(writer, "bad media", http.StatusBadRequest)
		return
	}
	if metadata.Name != request.URL.Query().Get("name") {
		server.t.Errorf("upload metadata name = %q, query name = %q", metadata.Name, request.URL.Query().Get("name"))
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	previous, exists := server.objects[metadata.Name]
	if condition := request.URL.Query().Get("ifGenerationMatch"); condition != "" {
		if condition == "0" && exists || condition != "0" && (!exists || previous.metadata.Generation != condition) {
			http.Error(writer, `{"error":{"code":412}}`, http.StatusPreconditionFailed)
			return
		}
	}
	server.nextGeneration++
	metadata.Generation = strconv.FormatInt(server.nextGeneration, 10)
	metadata.Size = strconv.Itoa(len(contents))
	metadata.ContentType = mediaPart.Header.Get("Content-Type")
	server.objects[metadata.Name] = localGCSTestObject{metadata: metadata, bytes: contents}
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(metadata)
}

func (server *localGCSTestServer) read(writer http.ResponseWriter, request *http.Request, key string) {
	server.mu.Lock()
	defer server.mu.Unlock()
	object, exists := server.objects[key]
	if !exists {
		http.NotFound(writer, request)
		return
	}
	if strings.HasPrefix(request.URL.Path, "/download/") || request.URL.Query().Get("alt") == "media" {
		writer.Header().Set("Content-Type", object.metadata.ContentType)
		_, _ = writer.Write(object.bytes)
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(object.metadata)
}

func (server *localGCSTestServer) list(writer http.ResponseWriter, request *http.Request) {
	server.mu.Lock()
	defer server.mu.Unlock()
	var keys []string
	for key := range server.objects {
		if strings.HasPrefix(key, request.URL.Query().Get("prefix")) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	start := 0
	if token := request.URL.Query().Get("pageToken"); token != "" {
		start, _ = strconv.Atoi(token)
	}
	end := min(start+2, len(keys))
	items := make([]gcsObjectMetadata, 0, end-start)
	for _, key := range keys[start:end] {
		items = append(items, server.objects[key].metadata)
	}
	result := gcsObjectList{Items: items}
	if end < len(keys) {
		result.NextPageToken = strconv.Itoa(end)
	}
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(result)
}

func (server *localGCSTestServer) batchDelete(writer http.ResponseWriter, request *http.Request) {
	mediaType, params, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/mixed" {
		http.Error(writer, "bad batch Content-Type", http.StatusBadRequest)
		return
	}
	reader := multipart.NewReader(request.Body, params["boundary"])
	var keys []string
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			http.Error(writer, "bad batch", http.StatusBadRequest)
			return
		}
		httpRequest, err := http.ReadRequest(bufio.NewReader(part))
		if err != nil {
			http.Error(writer, "bad inner request", http.StatusBadRequest)
			return
		}
		if httpRequest.Method != http.MethodDelete {
			server.t.Errorf("batch method = %s, want DELETE", httpRequest.Method)
		}
		keys = append(keys, decodeObjectKey(httpRequest.URL.EscapedPath(), "/storage/v1/b/artifact-pages/o/"))
	}
	server.mu.Lock()
	for _, key := range keys {
		delete(server.objects, key)
	}
	server.batchRequests++
	server.mu.Unlock()

	var response bytes.Buffer
	responseWriter := multipart.NewWriter(&response)
	for range keys {
		part, err := responseWriter.CreatePart(textproto.MIMEHeader{"Content-Type": {"application/http"}})
		if err != nil {
			http.Error(writer, "response encode failure", http.StatusInternalServerError)
			return
		}
		_, _ = io.WriteString(part, "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
	}
	_ = responseWriter.Close()
	writer.Header().Set("Content-Type", "multipart/mixed; boundary="+responseWriter.Boundary())
	_, _ = writer.Write(response.Bytes())
}

func decodeObjectKey(escapedPath, prefix string) string {
	index := strings.Index(escapedPath, prefix)
	if index < 0 {
		return ""
	}
	key, _ := url.PathUnescape(escapedPath[index+len(prefix):])
	return key
}
