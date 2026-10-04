//go:build t21audit

package publisher

import (
	"context"
	"fmt"
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/cloudfront"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Explicitly tagged T21 audit probes. Run with `go test -tags t21audit`; these
// instrument local fakes and are excluded from the ordinary test suite. The
// invalidation cases record the observed retry behavior for T21. They do not
// assert that behavior as a desired contract; see ISSUE-066 for the accepted
// retry outcome.
type t21RegistryCounts struct {
	*registryApplyTestBackend
	gets  int
	lists []string
}

func (b *t21RegistryCounts) GetObject(ctx context.Context, key string) (Object, string, error) {
	b.gets++
	return b.registryApplyTestBackend.GetObject(ctx, key)
}

func (b *t21RegistryCounts) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	b.lists = append(b.lists, prefix)
	return b.registryApplyTestBackend.ListKeys(ctx, prefix)
}

type t21CountingS3 struct {
	*fakeS3
	heads int
	puts  int
}

func (s *t21CountingS3) HeadObject(ctx context.Context, input *s3.HeadObjectInput, options ...func(*s3.Options)) (*s3.HeadObjectOutput, error) {
	s.heads++
	return s.fakeS3.HeadObject(ctx, input, options...)
}

func (s *t21CountingS3) PutObject(ctx context.Context, input *s3.PutObjectInput, options ...func(*s3.Options)) (*s3.PutObjectOutput, error) {
	s.puts++
	return s.fakeS3.PutObject(ctx, input, options...)
}

type t21FailingCloudFront struct {
	fakeCloudFront
	calls int
	fail  bool
}

func (f *t21FailingCloudFront) CreateInvalidation(ctx context.Context, input *cloudfront.CreateInvalidationInput, options ...func(*cloudfront.Options)) (*cloudfront.CreateInvalidationOutput, error) {
	f.calls++
	if f.fail {
		f.fail = false
		return nil, fmt.Errorf("injected invalidation failure")
	}
	return f.fakeCloudFront.CreateInvalidation(ctx, input, options...)
}

type t21CountingLockBackend struct {
	*lockMemoryBackend
	gets int
	puts int
}

func (b *t21CountingLockBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	b.gets++
	return b.lockMemoryBackend.GetObject(ctx, key)
}

func (b *t21CountingLockBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	b.puts++
	return b.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
}

func TestT21ProbeColdAndWarmLockCalls(t *testing.T) {
	backend := &t21CountingLockBackend{lockMemoryBackend: newLockMemoryBackend()}
	manager := SiteLockManager{Backend: backend}
	_, release, err := manager.Acquire(context.Background(), "t21")
	if err != nil {
		t.Fatal(err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	t.Logf("lock cold acquire+release: GET=%d conditionalPUT=%d", backend.gets, backend.puts)
	backend.gets, backend.puts = 0, 0
	_, release, err = manager.Acquire(context.Background(), "t21")
	if err != nil {
		t.Fatal(err)
	}
	if err := release(); err != nil {
		t.Fatal(err)
	}
	t.Logf("lock warm acquire+release: GET=%d conditionalPUT=%d", backend.gets, backend.puts)
	if backend.gets != 2 || backend.puts != 2 {
		t.Fatalf("warm counts changed: GET=%d conditionalPUT=%d", backend.gets, backend.puts)
	}
}

func TestT21ProbeRegistryAddOnlyInvalidationRetry(t *testing.T) {
	backend := &t21RegistryCounts{registryApplyTestBackend: newRegistryApplyTestBackend()}
	seedRegistryFromManifest(t, backend.registryApplyTestBackend, desiredAdminManifest)
	added := `schemaVersion: 1
sites:
  docs:
    name: Documentation
    repository: acme/docs
    sourcePath: artifacts
  new-site:
    name: New
    repository: acme/new
    sourcePath: docs
  sre:
    name: SRE & Platform
    repository: acme/sre
    sourcePath: docs/artifacts
`
	desired := testRegistryProjection(t, added)
	backend.failNextInvalidate = true
	first, firstErr := RegisterSites(context.Background(), backend, desired, false)
	firstReads, firstWrites := backend.gets, backend.conditionalWrites
	firstInvalidations := len(backend.invalidations)
	backend.gets, backend.conditionalWrites = 0, 0
	second, secondErr := RegisterSites(context.Background(), backend, desired, false)
	secondReads, secondWrites := backend.gets, backend.conditionalWrites
	_, _, journalErr := backend.registryApplyTestBackend.GetObject(context.Background(), registryCleanupKey)
	t.Logf("registry first: outcome=%s err=%v GET=%d conditionalPUT=%d invalidationAttempts=%d; retry: outcome=%s err=%v GET=%d conditionalPUT=%d invalidationAttempts=%d journalPresent=%t", first.Outcome, firstErr, firstReads, firstWrites, firstInvalidations, second.Outcome, secondErr, secondReads, secondWrites, len(backend.invalidations)-firstInvalidations, journalErr == nil)
	if secondErr != nil {
		t.Fatalf("retry probe failed unexpectedly: first=%+v/%v second=%+v/%v", first, firstErr, second, secondErr)
	}
}

func TestT21ProbeAppInvalidationRetry(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	s3Client := &t21CountingS3{fakeS3: newFakeS3()}
	cf := &t21FailingCloudFront{fail: true}
	backend, err := newAWSBackend(awsClients{s3: s3Client, cloudFront: cf}, AWSOptions{Bucket: "t21", DistributionID: "E-T21"})
	if err != nil {
		t.Fatal(err)
	}
	first, firstErr := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	firstHeads, firstPuts := s3Client.heads, s3Client.puts
	firstInvalidations := cf.calls
	s3Client.heads, s3Client.puts = 0, 0
	second, secondErr := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive})
	t.Logf("app first: outcome=%s err=%v HEAD=%d PUT=%d invalidations=%d; retry: outcome=%s err=%v HEAD=%d PUT=%d totalInvalidations=%d", first.Outcome, firstErr, firstHeads, firstPuts, firstInvalidations, second.Outcome, secondErr, s3Client.heads, s3Client.puts, cf.calls)
	if secondErr != nil {
		t.Fatalf("retry probe failed unexpectedly: second=%+v/%v invalidations=%d puts=%d", second, secondErr, cf.calls, s3Client.puts)
	}
}

func TestT21ProbeRegistryDryRunNoOpAndUnregisterCalls(t *testing.T) {
	desired := testRegistryProjection(t, desiredAdminManifest)
	backend := &t21RegistryCounts{registryApplyTestBackend: newRegistryApplyTestBackend()}
	seedRegistryFromManifest(t, backend.registryApplyTestBackend, desiredAdminManifest)
	dryRun, err := RegisterSites(context.Background(), backend, desired, true)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("registry dry-run same input: outcome=%s GET=%d conditionalPUT=%d LIST=%d invalidations=%d", dryRun.Outcome, backend.gets, backend.conditionalWrites, len(backend.lists), len(backend.invalidations))
	if backend.gets != 2 || backend.conditionalWrites != 0 || len(backend.lists) != 0 || len(backend.invalidations) != 0 {
		t.Fatalf("registry dry-run counts changed: GET=%d conditionalPUT=%d LIST=%v invalidations=%v", backend.gets, backend.conditionalWrites, backend.lists, backend.invalidations)
	}
	backend.gets, backend.conditionalWrites = 0, 0
	backend.lists, backend.invalidations = nil, nil
	noOp, err := RegisterSites(context.Background(), backend, desired, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("registry apply same input: outcome=%s GET=%d conditionalPUT=%d LIST=%d invalidations=%d", noOp.Outcome, backend.gets, backend.conditionalWrites, len(backend.lists), len(backend.invalidations))
	if noOp.Outcome != "no-op" || backend.conditionalWrites != 3 || len(backend.lists) != 0 || len(backend.invalidations) != 0 {
		t.Fatalf("registry no-op counts changed: result=%+v GET=%d conditionalPUT=%d LIST=%v invalidations=%v", noOp, backend.gets, backend.conditionalWrites, backend.lists, backend.invalidations)
	}
	backend.gets, backend.conditionalWrites = 0, 0
	warmNoOp, err := RegisterSites(context.Background(), backend, desired, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("registry apply warm same input: outcome=%s GET=%d conditionalPUT=%d LIST=%d invalidations=%d", warmNoOp.Outcome, backend.gets, backend.conditionalWrites, len(backend.lists), len(backend.invalidations))
	if warmNoOp.Outcome != "no-op" || backend.conditionalWrites != 2 || len(backend.lists) != 0 || len(backend.invalidations) != 0 {
		t.Fatalf("warm registry no-op counts changed: result=%+v GET=%d conditionalPUT=%d LIST=%v invalidations=%v", warmNoOp, backend.gets, backend.conditionalWrites, backend.lists, backend.invalidations)
	}

	cleanupBackend := &t21RegistryCounts{registryApplyTestBackend: newRegistryApplyTestBackend()}
	seedRegistryFromManifest(t, cleanupBackend.registryApplyTestBackend, currentAdminManifest)
	seedForcedUnregisterFixture(t, cleanupBackend.registryApplyTestBackend)
	for key, contents := range map[string][]byte{
		"_artifacts/legacy/report.html":             []byte("legacy artifact"),
		"_indexes/legacy/meta.json":                 []byte(`{"site":"legacy"}`),
		"_previews/legacy/catalog.json":             []byte(`{"site":"legacy"}`),
		"_previews/legacy/revisions/head/report.md": []byte("legacy preview"),
		sitePublishStateKey("legacy"):               []byte("private state"),
	} {
		cleanupBackend.seed(key, contents)
	}
	cleanupBackend.gets, cleanupBackend.conditionalWrites = 0, 0
	cleanup, err := UnregisterSite(context.Background(), cleanupBackend, testRegistryProjection(t, manifestWithoutLegacy), "legacy", false)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("registry unregister one site: outcome=%s GET=%d conditionalPUT=%d LIST=%v DELETEcalls=%d invalidations=%d keysRemoved=%d", cleanup.Outcome, cleanupBackend.gets, cleanupBackend.conditionalWrites, cleanupBackend.lists, cleanupBackend.deleteCalls, len(cleanupBackend.invalidations), cleanup.FilesRemoved)
	if cleanup.Outcome != "unregistered" || len(cleanupBackend.lists) != 4 || cleanupBackend.deleteCalls != 2 {
		t.Fatalf("unregister counts changed: result=%+v LIST=%v DELETEcalls=%d", cleanup, cleanupBackend.lists, cleanupBackend.deleteCalls)
	}
}

func TestT21ProbeAppDryRunCalls(t *testing.T) {
	archive := createWebBundle(t, map[string][]byte{
		"index.html":    []byte("<script src=\"/assets/app.js\"></script>"),
		"assets/app.js": []byte("window.app = true"),
	})
	s3Client := &t21CountingS3{fakeS3: newFakeS3()}
	cf := &t21FailingCloudFront{}
	backend, err := newAWSBackend(awsClients{s3: s3Client, cloudFront: cf}, AWSOptions{Bucket: "t21", DistributionID: "E-T21"})
	if err != nil {
		t.Fatal(err)
	}
	result, err := DeployApp(context.Background(), backend, AppDeployOptions{ArchivePath: archive, DryRun: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("app dry-run changed input: outcome=%s HEAD=%d PUT=%d invalidations=%d filesPlanned=%d", result.Outcome, s3Client.heads, s3Client.puts, cf.calls, result.FilesPublished)
	if result.Outcome != "planned" || s3Client.heads != 2 || s3Client.puts != 0 || cf.calls != 0 {
		t.Fatalf("app dry-run counts changed: result=%+v HEAD=%d PUT=%d invalidations=%d", result, s3Client.heads, s3Client.puts, cf.calls)
	}
}
