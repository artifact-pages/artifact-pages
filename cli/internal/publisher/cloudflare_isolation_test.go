package publisher

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCloudflareR2IgnoresSharedAWSConfiguration(t *testing.T) {
	directory := t.TempDir()
	badConfig := filepath.Join(directory, "config")
	if err := os.WriteFile(badConfig, []byte("[profile broken\nthis is = = not valid\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	badCredentials := filepath.Join(directory, "credentials")
	if err := os.WriteFile(badCredentials, []byte("[default\naws_access_key_id\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_CONFIG_FILE", badConfig)
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", badCredentials)
	t.Setenv("AWS_PROFILE", "profile-that-does-not-exist")
	t.Setenv("AWS_REGION", "eu-west-1")
	t.Setenv("AWS_DEFAULT_REGION", "eu-west-1")
	t.Setenv("AWS_ACCESS_KEY_ID", "aws-key-must-not-be-used")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "aws-secret-must-not-be-used")
	t.Setenv("AWS_CA_BUNDLE", filepath.Join(directory, "missing-ca.pem"))
	t.Setenv("AWS_ENDPOINT_URL", "http://127.0.0.1:1")
	t.Setenv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:1")
	t.Setenv("AWS_MAX_ATTEMPTS", "1")

	var authorization string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		authorization = request.Header.Get("Authorization")
		_, _ = io.Copy(io.Discard, request.Body)
		writer.Header().Set("ETag", `"etag"`)
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	backend, err := newCloudflareObjectBackend(context.Background(), server.URL, "artifact-pages", "r2-key", "r2-secret", "")
	if err != nil {
		t.Fatalf("newCloudflareObjectBackend() with broken AWS configuration: %v", err)
	}
	if err := backend.PutObject(context.Background(), "a.txt", Object{Bytes: []byte("x"), ContentType: "text/plain"}); err != nil {
		t.Fatalf("PutObject() with broken AWS configuration: %v", err)
	}
	if !strings.Contains(authorization, "Credential=r2-key/") || !strings.Contains(authorization, "/auto/s3/aws4_request") {
		t.Errorf("request was not signed with the explicit R2 key and region auto: %q", authorization)
	}
}
