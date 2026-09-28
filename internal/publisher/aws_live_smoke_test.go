package publisher

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tasuku43/git-artifact-pages/internal/registry"
)

// TestAWSProductionBackendSmoke is an explicit, write-enabled smoke for the
// real S3 conditional-write and metadata behavior used by production locks and
// publishers. It writes one unindexed object under a random registered-site
// artifact key, verifies create/CAS races and reads, then deletes that object.
// Set ARTIFACT_PAGES_AWS_SMOKE_RUN=1 and the other documented variables to run
// it; it is skipped during ordinary local test runs.
func TestAWSProductionBackendSmoke(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_AWS_SMOKE_RUN") != "1" {
		t.Skip("set ARTIFACT_PAGES_AWS_SMOKE_RUN=1 to run the write-enabled AWS S3 smoke")
	}

	region := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_SMOKE_REGION"))
	bucket := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_SMOKE_BUCKET"))
	siteID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_SMOKE_SITE"))
	distributionID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_AWS_SMOKE_DISTRIBUTION_ID"))
	if region == "" || bucket == "" || siteID == "" {
		t.Fatal("ARTIFACT_PAGES_AWS_SMOKE_REGION, ARTIFACT_PAGES_AWS_SMOKE_BUCKET, and ARTIFACT_PAGES_AWS_SMOKE_SITE are required")
	}
	if err := registry.ValidateSiteID(siteID); err != nil {
		t.Fatalf("invalid ARTIFACT_PAGES_AWS_SMOKE_SITE: %v", err)
	}
	confirmation := fmt.Sprintf("WRITE AND DELETE TEMPORARY OBJECT VERSIONS AND DELETE MARKERS IN S3 BUCKET %s FOR SITE %s", bucket, siteID)
	if got := os.Getenv("ARTIFACT_PAGES_AWS_SMOKE_CONFIRM"); got != confirmation {
		t.Fatalf("set ARTIFACT_PAGES_AWS_SMOKE_CONFIRM=%q to authorize temporary writes and version-aware deletion", confirmation)
	}

	randomPart := make([]byte, 12)
	if _, err := rand.Read(randomPart); err != nil {
		t.Fatalf("generate isolated smoke key: %v", err)
	}
	key := fmt.Sprintf("_artifacts/%s/.artifact-pages-aws-smoke-%s/object.json", siteID, hex.EncodeToString(randomPart))
	prefix := key[:strings.LastIndexByte(key, '/')+1]

	backend, err := NewAWSBackend(t.Context(), AWSOptions{
		Region: region, Bucket: bucket, DistributionID: distributionID,
	})
	if err != nil {
		t.Fatalf("create AWS backend: %v", err)
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		t.Fatal("AWS backend does not implement conditional object operations")
	}
	registered, err := loadOriginRegistry(t.Context(), conditional)
	if err != nil {
		t.Fatalf("read deployed registry: %v", err)
	}
	if _, found := registrySite(registered, siteID); !found {
		t.Fatalf("AWS smoke site %q is not present in the deployed registry", siteID)
	}
	awsTarget, ok := backend.(*awsBackend)
	if !ok {
		t.Fatalf("AWS smoke backend has unexpected type %T", backend)
	}
	versionClient, ok := awsTarget.s3CompatibleBackend.client.(awsLiveSmokeVersionAPI)
	if !ok {
		t.Fatalf("AWS smoke client %T does not support version-aware cleanup", awsTarget.s3CompatibleBackend.client)
	}
	versionSpec := awsArtifactSmokePrefixSpec
	versionSpec.site = siteID
	versions, err := listAWSLiveSmokeVersions(t.Context(), versionClient, bucket, prefix, versionSpec)
	if err != nil {
		t.Fatalf("check isolated AWS smoke prefix versions: %v", err)
	}
	if len(versions) != 0 {
		t.Fatalf("random AWS smoke prefix is unexpectedly occupied by versions or delete markers: %v", describeAWSLiveSmokeResiduals(versions))
	}

	cleanup := func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		return cleanupAWSLiveSmokePrefix(ctx, versionClient, bucket, prefix, versionSpec)
	}
	t.Cleanup(func() {
		if err := cleanup(); err != nil {
			t.Errorf("remove all temporary AWS smoke object versions and delete markers: %v", err)
		}
	})

	initial := Object{
		Bytes: []byte(`{"phase":"created"}`), ContentType: "application/json", ContentDisposition: "inline",
		Cache: "no-store", Metadata: map[string]string{"smoke": "artifact-pages"},
	}
	initialETag, err := conditional.PutObjectConditional(t.Context(), key, initial, ObjectCondition{IfNoneMatch: true})
	if err != nil {
		t.Fatalf("create object with If-None-Match: *: %v", err)
	}
	if initialETag == "" {
		t.Fatal("S3 conditional create returned an empty ETag")
	}
	if _, err := conditional.PutObjectConditional(t.Context(), key, initial, ObjectCondition{IfNoneMatch: true}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("second If-None-Match create error = %v, want ErrPreconditionFailed", err)
	}
	if _, err := conditional.PutObjectConditional(t.Context(), key, Object{Bytes: []byte("stale")}, ObjectCondition{IfMatchETag: `"stale-etag"`}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale If-Match error = %v, want ErrPreconditionFailed", err)
	}

	info, err := conditional.HeadObject(t.Context(), key)
	if err != nil {
		t.Fatalf("read object metadata: %v", err)
	}
	if info.ContentType != initial.ContentType || info.ContentDisposition != initial.ContentDisposition || info.ContentEncoding != "" || info.CacheControl != initial.Cache || info.Metadata["smoke"] != "artifact-pages" {
		t.Fatalf("S3 object metadata = %+v, want content type, inline disposition, absent encoding, cache, and user metadata from the projection", info)
	}
	read, readETag, err := conditional.GetObject(t.Context(), key)
	if err != nil {
		t.Fatalf("read object bytes: %v", err)
	}
	if string(read.Bytes) != string(initial.Bytes) || readETag != initialETag {
		t.Fatalf("S3 object read = bytes %q ETag %q; want %q %q", read.Bytes, readETag, initial.Bytes, initialETag)
	}

	listed, err := backend.ListKeys(t.Context(), prefix)
	if err != nil {
		t.Fatalf("list isolated smoke prefix: %v", err)
	}
	if len(listed) != 1 || listed[0] != key {
		t.Fatalf("listed smoke prefix = %q, want only %q", listed, key)
	}

	updated := Object{
		Bytes: []byte(`{"phase":"compare-and-swap"}`), ContentType: "application/json",
		Cache: "no-store", Metadata: map[string]string{"smoke": "artifact-pages-cas"},
	}
	currentETag, err := conditional.PutObjectConditional(t.Context(), key, updated, ObjectCondition{IfMatchETag: initialETag})
	if err != nil {
		t.Fatalf("compare-and-swap update with observed ETag: %v", err)
	}
	if currentETag == "" {
		t.Fatal("S3 compare-and-swap update returned an empty ETag")
	}

	// Two writers using the same observed version must not both succeed. This
	// exercises S3's real conditional-write race, not only its request shape.
	type raceResult struct{ err error }
	start := make(chan struct{})
	results := make(chan raceResult, 2)
	for index := 0; index < 2; index++ {
		go func(index int) {
			<-start
			candidate := Object{
				Bytes: []byte(fmt.Sprintf(`{"writer":%d}`, index)), ContentType: "application/json", Cache: "no-store",
			}
			_, err := conditional.PutObjectConditional(t.Context(), key, candidate, ObjectCondition{IfMatchETag: currentETag})
			results <- raceResult{err: err}
		}(index)
	}
	close(start)
	successes, conflicts := 0, 0
	for range 2 {
		result := <-results
		switch {
		case result.err == nil:
			successes++
		case errors.Is(result.err, ErrPreconditionFailed):
			conflicts++
		default:
			t.Fatalf("conditional race returned unexpected error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("conditional race outcomes = %d success, %d conflict; want exactly one of each", successes, conflicts)
	}

	if distributionID != "" {
		invalidatedID, err := backend.Invalidate(t.Context(), []string{"/" + key})
		if err != nil {
			t.Fatalf("request CloudFront invalidation: %v", err)
		}
		if invalidatedID == "" {
			t.Fatal("CloudFront accepted invalidation but returned no ID")
		}
	}
}
