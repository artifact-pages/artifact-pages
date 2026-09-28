package publisher

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	cloudfronttypes "github.com/aws/aws-sdk-go-v2/service/cloudfront/types"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

type uploadedObject struct {
	body               []byte
	contentType        string
	contentDisposition string
	contentEncoding    string
	cache              string
	metadata           map[string]string
}

type fakeS3 struct {
	objects map[string]uploadedObject
	puts    []string
}

func newFakeS3() *fakeS3 {
	return &fakeS3{objects: make(map[string]uploadedObject)}
}

func (f *fakeS3) PutObject(_ context.Context, input *s3.PutObjectInput, _ ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	body, err := io.ReadAll(input.Body)
	if err != nil {
		return nil, err
	}
	key := aws.ToString(input.Key)
	f.objects[key] = uploadedObject{
		body:               body,
		contentType:        aws.ToString(input.ContentType),
		contentDisposition: aws.ToString(input.ContentDisposition),
		contentEncoding:    aws.ToString(input.ContentEncoding),
		cache:              aws.ToString(input.CacheControl),
		metadata:           input.Metadata,
	}
	f.puts = append(f.puts, key)
	return &s3.PutObjectOutput{}, nil
}

func (f *fakeS3) HeadObject(_ context.Context, input *s3.HeadObjectInput, _ ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	object, exists := f.objects[aws.ToString(input.Key)]
	if !exists {
		return nil, ErrObjectNotFound
	}
	return &s3.HeadObjectOutput{
		ContentLength: aws.Int64(int64(len(object.body))), ContentType: aws.String(object.contentType),
		ContentDisposition: aws.String(object.contentDisposition), ContentEncoding: aws.String(object.contentEncoding),
		CacheControl: aws.String(object.cache), Metadata: object.metadata,
	}, nil
}

func (f *fakeS3) ListObjectsV2(_ context.Context, input *s3.ListObjectsV2Input, _ ...func(*s3.Options)) (*s3.ListObjectsV2Output, error) {
	prefix := aws.ToString(input.Prefix)
	keys := make([]string, 0)
	for key := range f.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	contents := make([]types.Object, 0, len(keys))
	for _, key := range keys {
		contents = append(contents, types.Object{Key: aws.String(key)})
	}
	return &s3.ListObjectsV2Output{Contents: contents, IsTruncated: aws.Bool(false)}, nil
}

func (f *fakeS3) DeleteObjects(_ context.Context, input *s3.DeleteObjectsInput, _ ...func(*s3.Options)) (*s3.DeleteObjectsOutput, error) {
	for _, object := range input.Delete.Objects {
		delete(f.objects, aws.ToString(object.Key))
	}
	return &s3.DeleteObjectsOutput{}, nil
}

type fakeCloudFront struct {
	invalidations [][]string
}

func (f *fakeCloudFront) CreateInvalidation(_ context.Context, input *cloudfront.CreateInvalidationInput, _ ...func(*cloudfront.Options)) (*cloudfront.CreateInvalidationOutput, error) {
	paths := append([]string(nil), input.InvalidationBatch.Paths.Items...)
	f.invalidations = append(f.invalidations, paths)
	return &cloudfront.CreateInvalidationOutput{Invalidation: &cloudfronttypes.Invalidation{Id: aws.String("I-test")}}, nil
}

func TestDeployAppVerifiesAndPublishesBundle(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":              []byte("<!doctype html><script src=\"/assets/app-123.js\"></script>"),
		"assets/app-123.js":       []byte("console.log('ready')"),
		"assets/theme-456.css":    []byte("body { color: #123; }"),
		"LICENSE":                 []byte("Project license text\n"),
		"THIRD_PARTY_NOTICES.txt": []byte("Third-party notice text\n"),
		"preview-bridge.js":       []byte("window.previewBridge = true"),
	})
	s3Client := newFakeS3()
	cloudFront := &fakeCloudFront{}
	backend, err := newAWSBackend(awsClients{s3: s3Client, cloudFront: cloudFront}, AWSOptions{
		Bucket: "example-bucket", DistributionID: "E123TEST",
	})
	if err != nil {
		t.Fatal(err)
	}
	planned, err := DeployApp(context.Background(), backend, AppDeployOptions{
		ArchivePath: archive,
		DryRun:      true,
	})
	if err != nil {
		t.Fatalf("DeployApp() dry-run error = %v", err)
	}
	wantPlan := []Change{
		{Action: "create", Path: "LICENSE"},
		{Action: "create", Path: "THIRD_PARTY_NOTICES.txt"},
		{Action: "create", Path: "assets/app-123.js"},
		{Action: "create", Path: "assets/theme-456.css"},
		{Action: "create", Path: "preview-bridge.js"},
		{Action: "create", Path: "index.html"},
	}
	if planned.Outcome != "planned" || planned.FilesPublished != 6 || !reflect.DeepEqual(planned.Changes, wantPlan) {
		t.Fatalf("DeployApp() dry-run = %+v, want read-only plan %+v", planned, wantPlan)
	}
	if len(s3Client.puts) != 0 || len(cloudFront.invalidations) != 0 {
		t.Fatalf("DeployApp() dry-run wrote objects or invalidated cache: puts=%v invalidations=%v", s3Client.puts, cloudFront.invalidations)
	}

	result, err := DeployApp(context.Background(), backend, AppDeployOptions{
		ArchivePath: archive,
	})
	if err != nil {
		t.Fatalf("DeployApp() error = %v", err)
	}
	if result.Version != "test-1" || result.FilesPublished != 6 {
		t.Fatalf("DeployApp() = %+v, want version test-1 and all 6 manifest files", result)
	}
	if got := string(s3Client.objects["index.html"].body); !strings.Contains(got, "app-123.js") {
		t.Fatalf("uploaded application shell = %q", got)
	}
	if got := s3Client.objects["index.html"].cache; got != appShellCache {
		t.Errorf("index.html Cache-Control = %q, want %q", got, appShellCache)
	}
	if got := s3Client.objects["assets/app-123.js"].cache; got != immutableCache {
		t.Errorf("hashed asset Cache-Control = %q, want %q", got, immutableCache)
	}
	for filePath, want := range map[string]string{
		"LICENSE":                 "Project license text\n",
		"THIRD_PARTY_NOTICES.txt": "Third-party notice text\n",
	} {
		object := s3Client.objects[filePath]
		if string(object.body) != want || object.contentType != "text/plain; charset=utf-8" || object.cache != appShellCache {
			t.Errorf("notice object %q = body %q, type %q, cache %q; want its manifest bytes, text/plain, and revalidation", filePath, object.body, object.contentType, object.cache)
		}
	}
	if got := s3Client.objects["index.html"].metadata["artifact-pages-version"]; got != "test-1" {
		t.Errorf("application version metadata = %q, want test-1", got)
	}
	if len(cloudFront.invalidations) != 1 || strings.Join(cloudFront.invalidations[0], ",") != "/index.html" {
		t.Errorf("CloudFront invalidations = %#v, want only /index.html", cloudFront.invalidations)
	}
	if len(s3Client.puts) == 0 || s3Client.puts[len(s3Client.puts)-1] != "index.html" {
		t.Errorf("index.html should be published after its assets; upload order = %#v", s3Client.puts)
	}
	s3Client.puts = nil
	cloudFront.invalidations = nil
	unchanged, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("DeployApp() unchanged bundle error = %v", err)
	}
	if unchanged.Outcome != "no-op" || unchanged.FilesPublished != 0 || len(s3Client.puts) != 0 || len(cloudFront.invalidations) != 0 {
		t.Errorf("DeployApp() unchanged result = %+v, puts=%v invalidations=%v; want no-op without provider writes", unchanged, s3Client.puts, cloudFront.invalidations)
	}
}

func TestDeployAppRejectsChecksumMismatchBeforeUpload(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":        []byte("shell"),
		"assets/app-123.js": []byte("asset"),
	})
	if err := os.WriteFile(archive+".sha256", []byte(strings.Repeat("0", 64)+"  "+filepath.Base(archive)+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s3Client := newFakeS3()
	backend, err := newAWSBackend(awsClients{s3: s3Client}, AWSOptions{Bucket: "example-bucket"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = DeployApp(context.Background(), backend, AppDeployOptions{
		ArchivePath: archive,
	})
	if err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("DeployApp() error = %v, want checksum mismatch", err)
	}
	if len(s3Client.puts) != 0 {
		t.Fatalf("DeployApp() uploaded files before validation failed: %#v", s3Client.puts)
	}
}

func TestDeployAppRejectsMissingBundleBeforeAnyWrite(t *testing.T) {
	backend := &memoryDeploymentBackend{objects: map[string]Object{
		"_indexes/sre/index.json":    {Bytes: []byte(`{"site":"sre"}`)},
		"_artifacts/sre/report.html": {Bytes: []byte("site artifact")},
	}}
	_, err := DeployApp(context.Background(), backend, AppDeployOptions{
		ArchivePath: filepath.Join(t.TempDir(), "missing-web-release.tar.gz"),
	})
	if err == nil || !strings.Contains(err.Error(), "open application archive") {
		t.Fatalf("DeployApp() error = %v, want missing application archive error", err)
	}
	if len(backend.puts) != 0 || len(backend.invalidations) != 0 {
		t.Fatalf("missing bundle caused provider effects: puts=%v invalidations=%v", backend.puts, backend.invalidations)
	}
	if got := string(backend.objects["_indexes/sre/index.json"].Bytes); got != `{"site":"sre"}` {
		t.Errorf("site index changed after missing bundle: %q", got)
	}
	if got := string(backend.objects["_artifacts/sre/report.html"].Bytes); got != "site artifact" {
		t.Errorf("site artifact changed after missing bundle: %q", got)
	}
}

func TestDeployAppUnchangedBundleIsNoOpAndPreservesSiteContent(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":        []byte("shell referencing app-123.js"),
		"assets/app-123.js": []byte("console.log('ready')"),
		"preview-bridge.js": []byte("window.previewBridge = true"),
	})
	backend := &memoryDeploymentBackend{objects: map[string]Object{
		"_indexes/sites.json":        {Bytes: []byte(`{"sites":[{"id":"sre"}]}`)},
		"_indexes/sre/index.json":    {Bytes: []byte(`{"site":"sre"}`)},
		"_artifacts/sre/report.html": {Bytes: []byte("<h1>site content</h1>")},
		"_previews/sre/catalog.json": {Bytes: []byte(`{"site":"sre"}`)},
	}}
	contentBefore := map[string][]byte{}
	for key, object := range backend.objects {
		contentBefore[key] = append([]byte(nil), object.Bytes...)
	}

	first, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("first DeployApp() error = %v", err)
	}
	if first.Outcome != "deployed" || first.FilesPublished != 3 {
		t.Fatalf("first DeployApp() = %+v, want deployment of all three app files", first)
	}
	for key, want := range contentBefore {
		if got := backend.objects[key].Bytes; string(got) != string(want) {
			t.Errorf("site content object %q changed on app deploy: got %q, want %q", key, got, want)
		}
	}

	backend.puts = nil
	backend.invalidations = nil
	second, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	if err != nil {
		t.Fatalf("second DeployApp() error = %v", err)
	}
	if second.Outcome != "no-op" || second.FilesPublished != 0 || second.Version != first.Version {
		t.Fatalf("second DeployApp() = %+v, want no-op for unchanged bundle", second)
	}
	if len(backend.puts) != 0 || len(backend.invalidations) != 0 {
		t.Fatalf("unchanged bundle caused provider effects: puts=%v invalidations=%v", backend.puts, backend.invalidations)
	}
	for key, want := range contentBefore {
		if got := backend.objects[key].Bytes; string(got) != string(want) {
			t.Errorf("site content object %q changed on no-op app deploy: got %q, want %q", key, got, want)
		}
	}
}

func TestLoadAppBundleRejectsContentPlanePaths(t *testing.T) {
	for _, path := range []string{
		"_indexes/sites.json",
		"_artifacts/sre/report.html",
		"_previews/sre/catalog.json",
		"_control/locks/sre.json",
	} {
		t.Run(path, func(t *testing.T) {
			archive := createWebBundleWithEntries(t, []bundleFile{
				{path: "index.html", data: []byte("shell")},
				{path: "assets/app.js", data: []byte("asset")},
				{path: path, data: []byte("must not be deployed")},
			})
			if _, err := loadAppBundle(archive); err == nil || !strings.Contains(err.Error(), "plane files") {
				t.Fatalf("loadAppBundle() error = %v, want reserved storage path rejection", err)
			}
		})
	}
}

func TestLoadAppBundleRejectsTraversalEntries(t *testing.T) {
	archive := createWebBundleWithEntries(t, []bundleFile{
		{path: "index.html", data: []byte("shell")},
		{path: "assets/app.js", data: []byte("asset")},
		{path: "../escape.txt", data: []byte("escape")},
	})
	_, err := loadAppBundle(archive)
	if err == nil || !strings.Contains(err.Error(), "unsafe path") {
		t.Fatalf("loadAppBundle() error = %v, want unsafe archive path", err)
	}
}

func createWebBundle(t *testing.T, files map[string][]byte) string {
	t.Helper()
	entries := make([]bundleFile, 0, len(files))
	for file, body := range files {
		entries = append(entries, bundleFile{path: file, data: body})
	}
	return createWebBundleWithEntries(t, entries)
}

func createWebBundleWithEntries(t *testing.T, entries []bundleFile) string {
	t.Helper()
	directory := t.TempDir()
	archiveName := "artifact-pages-web-vtest-1.tar.gz"
	archivePath := filepath.Join(directory, archiveName)
	archiveFile, err := os.Create(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(archiveFile)
	tarWriter := tar.NewWriter(gzipWriter)
	paths := make([]string, 0, len(entries))
	for _, file := range entries {
		paths = append(paths, file.path)
	}
	sort.Strings(paths)
	dataByPath := make(map[string][]byte, len(entries))
	for _, file := range entries {
		dataByPath[file.path] = file.data
	}
	for _, filePath := range paths {
		body := dataByPath[filePath]
		header := &tar.Header{Name: "./" + filePath, Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg}
		if err := tarWriter.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err := tarWriter.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := archiveFile.Close(); err != nil {
		t.Fatal(err)
	}
	archiveBytes, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(archiveBytes)
	digest := hex.EncodeToString(hash[:])
	manifestFiles := append([]string(nil), paths...)
	manifest := releaseManifest{
		SchemaVersion: 1,
		Product:       "artifact-pages",
		Component:     "web",
		Version:       "test-1",
		Archive:       archiveName,
		ArchiveSHA256: digest,
		SourceCommit:  "0123456789abcdef",
		Files:         manifestFiles,
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(archivePath+".json", manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	checksum := fmt.Sprintf("%s  %s\n", digest, archiveName)
	if err := os.WriteFile(archivePath+".sha256", []byte(checksum), 0o600); err != nil {
		t.Fatal(err)
	}
	return archivePath
}
