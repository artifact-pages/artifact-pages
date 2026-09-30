package publisher

// This adapter exists only for the local fake-gcs-server conformance profile.
// It speaks the public Cloud Storage JSON API so tests exercise HTTP requests,
// but it does not claim that GCP is a supported production provider.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/textproto"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	gcsLocalGenerationPrefix = "gcs-generation:"
	gcsLocalBatchLimit       = 100
	gcsLocalMaxObjectBytes   = 64 << 20
)

type localGCSBackend struct {
	endpoint *url.URL
	bucket   string
	http     *http.Client
}

var _ ConditionalObjectBackend = (*localGCSBackend)(nil)

// NewLocalGCSBackend creates an emulator-only adapter for fake-gcs-server's
// Cloud Storage JSON API. The endpoint must be a local HTTP emulator.
func NewLocalGCSBackend(endpoint, bucket string) (ConditionalObjectBackend, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" {
		return nil, errors.New("local GCS endpoint must be an HTTP origin")
	}
	if parsed.Hostname() != "localhost" {
		ip := net.ParseIP(parsed.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return nil, errors.New("local GCS endpoint must use a loopback host")
		}
	}
	if strings.TrimSpace(bucket) == "" {
		return nil, errors.New("local GCS bucket is required")
	}
	return &localGCSBackend{
		endpoint: parsed,
		bucket:   bucket,
		http:     &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}, nil
}

func (backend *localGCSBackend) PutObject(ctx context.Context, key string, object Object) error {
	_, err := backend.put(ctx, key, object, ObjectCondition{})
	return err
}

func (backend *localGCSBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	return backend.put(ctx, key, object, condition)
}

func (backend *localGCSBackend) put(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	if key == "" || strings.ContainsRune(key, '\x00') {
		return "", errors.New("GCS object name is required")
	}
	if condition.IfNoneMatch && condition.IfMatchETag != "" {
		return "", errors.New("conditional object write cannot use both If-Match and If-None-Match")
	}
	query := url.Values{"uploadType": {"multipart"}, "name": {key}}
	if condition.IfNoneMatch {
		query.Set("ifGenerationMatch", "0")
	}
	if condition.IfMatchETag != "" {
		generation, err := parseGCSGeneration(condition.IfMatchETag)
		if err != nil {
			return "", err
		}
		query.Set("ifGenerationMatch", generation)
	}
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	metadata := map[string]any{
		"name":        key,
		"contentType": object.ContentType,
	}
	if object.Cache != "" {
		metadata["cacheControl"] = object.Cache
	}
	if object.ContentDisposition != "" {
		metadata["contentDisposition"] = object.ContentDisposition
	}
	if object.ContentEncoding != "" {
		metadata["contentEncoding"] = object.ContentEncoding
	}
	if len(object.Metadata) != 0 {
		metadata["metadata"] = object.Metadata
	}
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		return "", fmt.Errorf("encode GCS object metadata: %w", err)
	}
	metadataHeader := make(textproto.MIMEHeader)
	metadataHeader.Set("Content-Type", "application/json; charset=UTF-8")
	metadataPart, err := writer.CreatePart(metadataHeader)
	if err != nil {
		return "", fmt.Errorf("create GCS metadata part: %w", err)
	}
	if _, err := metadataPart.Write(metadataBytes); err != nil {
		return "", fmt.Errorf("write GCS metadata part: %w", err)
	}
	mediaHeader := make(textproto.MIMEHeader)
	mediaType := object.ContentType
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	mediaHeader.Set("Content-Type", mediaType)
	mediaPart, err := writer.CreatePart(mediaHeader)
	if err != nil {
		return "", fmt.Errorf("create GCS object data part: %w", err)
	}
	if _, err := mediaPart.Write(object.Bytes); err != nil {
		return "", fmt.Errorf("write GCS object data part: %w", err)
	}
	if err := writer.Close(); err != nil {
		return "", fmt.Errorf("finish GCS upload body: %w", err)
	}
	endpoint := backend.apiURL("/upload/storage/v1/b/" + url.PathEscape(backend.bucket) + "/o")
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), &body)
	if err != nil {
		return "", fmt.Errorf("create GCS object upload: %w", err)
	}
	request.Header.Set("Content-Type", "multipart/related; boundary="+writer.Boundary())
	response, err := backend.http.Do(request)
	if err != nil {
		return "", fmt.Errorf("send GCS object upload: %w", err)
	}
	defer response.Body.Close()
	if err := gcsResponseError(response); err != nil {
		return "", err
	}
	var result gcsObjectMetadata
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&result); err != nil {
		return "", fmt.Errorf("decode GCS upload response: %w", err)
	}
	return generationToken(result.Generation), nil
}

func (backend *localGCSBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	metadata, err := backend.objectMetadata(ctx, key)
	if err != nil {
		return Object{}, "", err
	}
	endpoint := backend.objectURL("/download/storage/v1/b/"+url.PathEscape(backend.bucket)+"/o/", key)
	query := endpoint.Query()
	query.Set("alt", "media")
	endpoint.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return Object{}, "", fmt.Errorf("create GCS object download: %w", err)
	}
	response, err := backend.http.Do(request)
	if err != nil {
		return Object{}, "", fmt.Errorf("send GCS object download: %w", err)
	}
	defer response.Body.Close()
	if err := gcsResponseError(response); err != nil {
		return Object{}, "", err
	}
	contents, err := io.ReadAll(io.LimitReader(response.Body, gcsLocalMaxObjectBytes+1))
	if err != nil {
		return Object{}, "", fmt.Errorf("read GCS object data: %w", err)
	}
	if len(contents) > gcsLocalMaxObjectBytes {
		return Object{}, "", fmt.Errorf("GCS object %q exceeds the local adapter read limit of %d bytes", key, gcsLocalMaxObjectBytes)
	}
	return Object{
		Bytes: contents, ContentType: metadata.ContentType,
		ContentDisposition: metadata.ContentDisposition, ContentEncoding: metadata.ContentEncoding,
		Cache: metadata.CacheControl, Metadata: metadata.Metadata,
	}, generationToken(metadata.Generation), nil
}

func (backend *localGCSBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	metadata, err := backend.objectMetadata(ctx, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	size, _ := strconv.ParseInt(metadata.Size, 10, 64)
	return ObjectInfo{
		ETag: generationToken(metadata.Generation), Size: size,
		ContentType: metadata.ContentType, ContentDisposition: metadata.ContentDisposition,
		ContentEncoding: metadata.ContentEncoding, CacheControl: metadata.CacheControl,
		Metadata: metadata.Metadata,
	}, nil
}

func (backend *localGCSBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	keys := make([]string, 0)
	seenTokens := make(map[string]struct{})
	pageToken := ""
	for {
		endpoint := backend.apiURL("/storage/v1/b/" + url.PathEscape(backend.bucket) + "/o")
		query := endpoint.Query()
		query.Set("prefix", prefix)
		query.Set("maxResults", "1000")
		if pageToken != "" {
			query.Set("pageToken", pageToken)
		}
		endpoint.RawQuery = query.Encode()
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
		if err != nil {
			return nil, fmt.Errorf("create GCS object listing: %w", err)
		}
		response, err := backend.http.Do(request)
		if err != nil {
			return nil, fmt.Errorf("send GCS object listing: %w", err)
		}
		if err := gcsResponseError(response); err != nil {
			response.Body.Close()
			return nil, err
		}
		var page gcsObjectList
		err = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&page)
		response.Body.Close()
		if err != nil {
			return nil, fmt.Errorf("decode GCS object listing: %w", err)
		}
		for _, item := range page.Items {
			if !strings.HasPrefix(item.Name, prefix) {
				return nil, fmt.Errorf("GCS object listing returned %q outside requested prefix %q", item.Name, prefix)
			}
			keys = append(keys, item.Name)
		}
		if page.NextPageToken == "" {
			break
		}
		if _, duplicate := seenTokens[page.NextPageToken]; duplicate {
			return nil, errors.New("GCS object listing repeated a page token")
		}
		seenTokens[page.NextPageToken] = struct{}{}
		pageToken = page.NextPageToken
	}
	sort.Strings(keys)
	return keys, nil
}

func (backend *localGCSBackend) DeleteObjects(ctx context.Context, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	ordered := append([]string(nil), keys...)
	sort.Strings(ordered)
	for start := 0; start < len(ordered); start += gcsLocalBatchLimit {
		end := min(start+gcsLocalBatchLimit, len(ordered))
		if err := backend.deleteBatch(ctx, ordered[start:end]); err != nil {
			return err
		}
	}
	return nil
}

func (backend *localGCSBackend) deleteBatch(ctx context.Context, keys []string) error {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for index, key := range keys {
		partHeader := make(textproto.MIMEHeader)
		partHeader.Set("Content-Type", "application/http")
		partHeader.Set("Content-Transfer-Encoding", "binary")
		partHeader.Set("Content-ID", fmt.Sprintf("<delete-%d>", index))
		part, err := writer.CreatePart(partHeader)
		if err != nil {
			return fmt.Errorf("create GCS batch delete part: %w", err)
		}
		objectURL := backend.objectURL("/storage/v1/b/"+url.PathEscape(backend.bucket)+"/o/", key)
		if _, err := fmt.Fprintf(part, "DELETE %s HTTP/1.1\r\n\r\n", objectURL.RequestURI()); err != nil {
			return fmt.Errorf("write GCS batch delete request: %w", err)
		}
	}
	if err := writer.Close(); err != nil {
		return fmt.Errorf("finish GCS batch delete body: %w", err)
	}
	endpoint := backend.apiURL("/batch/storage/v1")
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), &body)
	if err != nil {
		return fmt.Errorf("create GCS batch delete: %w", err)
	}
	request.Header.Set("Content-Type", "multipart/mixed; boundary="+writer.Boundary())
	response, err := backend.http.Do(request)
	if err != nil {
		return fmt.Errorf("send GCS batch delete: %w", err)
	}
	defer response.Body.Close()
	if err := gcsResponseError(response); err != nil {
		return err
	}
	mediaType, params, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/mixed" {
		return errors.New("GCS batch delete returned a non-multipart response")
	}
	reader := multipart.NewReader(response.Body, params["boundary"])
	responses := 0
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read GCS batch delete response: %w", err)
		}
		firstLine, err := readHTTPStatusLine(part)
		part.Close()
		if err != nil {
			return err
		}
		fields := strings.Fields(firstLine)
		if len(fields) < 2 || !strings.HasPrefix(fields[0], "HTTP/") {
			return fmt.Errorf("invalid GCS batch response status line %q", firstLine)
		}
		status, parseErr := strconv.Atoi(fields[1])
		if parseErr != nil {
			return fmt.Errorf("invalid GCS batch response status line %q", firstLine)
		}
		responses++
		if status < 200 || status >= 300 {
			return fmt.Errorf("GCS batch delete operation failed (HTTP %d)", status)
		}
	}
	if responses != len(keys) {
		return fmt.Errorf("GCS batch delete returned %d results for %d objects", responses, len(keys))
	}
	return nil
}

func readHTTPStatusLine(reader io.Reader) (string, error) {
	buffered := bufio.NewReader(reader)
	line, err := buffered.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("read GCS batch response status: %w", err)
	}
	return strings.TrimSpace(line), nil
}

func (backend *localGCSBackend) Invalidate(context.Context, []string) (string, error) {
	// The local edge has no CDN control plane. Browser cache policy is exercised
	// independently through the edge response headers.
	return "", nil
}

func (backend *localGCSBackend) objectMetadata(ctx context.Context, key string) (gcsObjectMetadata, error) {
	if key == "" || strings.ContainsRune(key, '\x00') {
		return gcsObjectMetadata{}, errors.New("GCS object name is required")
	}
	endpoint := backend.objectURL("/storage/v1/b/"+url.PathEscape(backend.bucket)+"/o/", key)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return gcsObjectMetadata{}, fmt.Errorf("create GCS object metadata request: %w", err)
	}
	response, err := backend.http.Do(request)
	if err != nil {
		return gcsObjectMetadata{}, fmt.Errorf("send GCS object metadata request: %w", err)
	}
	defer response.Body.Close()
	if err := gcsResponseError(response); err != nil {
		return gcsObjectMetadata{}, err
	}
	var metadata gcsObjectMetadata
	if err := json.NewDecoder(io.LimitReader(response.Body, 2<<20)).Decode(&metadata); err != nil {
		return gcsObjectMetadata{}, fmt.Errorf("decode GCS object metadata: %w", err)
	}
	if metadata.Generation == "" {
		return gcsObjectMetadata{}, errors.New("GCS object metadata omitted generation")
	}
	return metadata, nil
}

func (backend *localGCSBackend) apiURL(path string) *url.URL {
	copy := *backend.endpoint
	copy.Path = strings.TrimRight(copy.Path, "/") + path
	copy.RawPath = ""
	return &copy
}

func (backend *localGCSBackend) objectURL(prefix, key string) *url.URL {
	copy := *backend.endpoint
	path := strings.TrimRight(copy.Path, "/") + prefix + key
	encoded := strings.TrimRight(copy.EscapedPath(), "/") + prefix + url.PathEscape(key)
	copy.Path = path
	copy.RawPath = encoded
	return &copy
}

func gcsResponseError(response *http.Response) error {
	switch response.StatusCode {
	case http.StatusNotFound:
		return ErrObjectNotFound
	case http.StatusPreconditionFailed, http.StatusConflict:
		return ErrPreconditionFailed
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("GCS JSON API request failed (HTTP %d)", response.StatusCode)
	}
	return nil
}

func generationToken(raw string) string {
	if raw == "" {
		return ""
	}
	return gcsLocalGenerationPrefix + raw
}

func parseGCSGeneration(token string) (string, error) {
	if !strings.HasPrefix(token, gcsLocalGenerationPrefix) {
		return "", errors.New("GCS conditional write requires a generation token from this local adapter")
	}
	generation := strings.TrimPrefix(token, gcsLocalGenerationPrefix)
	if generation == "" {
		return "", errors.New("GCS conditional write generation token is empty")
	}
	if _, err := strconv.ParseInt(generation, 10, 64); err != nil {
		return "", errors.New("GCS conditional write generation token is invalid")
	}
	return generation, nil
}

type gcsObjectMetadata struct {
	Name               string            `json:"name"`
	Generation         string            `json:"generation"`
	Size               string            `json:"size"`
	ContentType        string            `json:"contentType"`
	ContentDisposition string            `json:"contentDisposition"`
	ContentEncoding    string            `json:"contentEncoding"`
	CacheControl       string            `json:"cacheControl"`
	Metadata           map[string]string `json:"metadata"`
}

type gcsObjectList struct {
	Items         []gcsObjectMetadata `json:"items"`
	NextPageToken string              `json:"nextPageToken"`
}
