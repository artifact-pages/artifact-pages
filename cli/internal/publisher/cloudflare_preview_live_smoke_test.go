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

	"github.com/tasuku43/git-artifact-pages/cli/internal/registry"
)

// TestCloudflarePreviewBackendSmoke is an explicit write-enabled smoke for the
// R2 conditional object operations used by preview publication. It writes only
// below a fresh, unadvertised key under one explicitly selected registered
// site's _previews prefix, verifies create/CAS/race/read behavior, then removes
// the isolated prefix. Ordinary test runs skip this test.
func TestCloudflarePreviewBackendSmoke(t *testing.T) {
	if os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_RUN") != "1" {
		t.Skip("set ARTIFACT_PAGES_CLOUDFLARE_SMOKE_RUN=1 to run the write-enabled Cloudflare R2 preview smoke")
	}

	accountID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_ACCOUNT_ID"))
	bucket := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_BUCKET"))
	zoneID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_ZONE_ID"))
	publicBaseURL := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_PUBLIC_BASE_URL"))
	siteID := strings.TrimSpace(os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_SITE"))
	accessKeyID := strings.TrimSpace(os.Getenv("CF_R2_ACCESS_KEY_ID"))
	secretAccessKey := strings.TrimSpace(os.Getenv("CF_R2_SECRET_ACCESS_KEY"))
	sessionToken := strings.TrimSpace(os.Getenv("CF_R2_SESSION_TOKEN"))
	if accountID == "" || bucket == "" || zoneID == "" || publicBaseURL == "" || siteID == "" || accessKeyID == "" || secretAccessKey == "" {
		t.Fatal("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_ACCOUNT_ID, _BUCKET, _ZONE_ID, _PUBLIC_BASE_URL, _SITE, CF_R2_ACCESS_KEY_ID, and CF_R2_SECRET_ACCESS_KEY are required")
	}
	if err := registry.ValidateSiteID(siteID); err != nil {
		t.Fatalf("invalid ARTIFACT_PAGES_CLOUDFLARE_SMOKE_SITE: %v", err)
	}
	confirmation := fmt.Sprintf("WRITE AND DELETE TEMPORARY OBJECTS IN %s UNDER SITE %s", bucket, siteID)
	if got := os.Getenv("ARTIFACT_PAGES_CLOUDFLARE_SMOKE_CONFIRM"); got != confirmation {
		t.Fatalf("set ARTIFACT_PAGES_CLOUDFLARE_SMOKE_CONFIRM=%q to authorize temporary writes and deletion", confirmation)
	}

	randomPart := make([]byte, 12)
	if _, err := rand.Read(randomPart); err != nil {
		t.Fatalf("generate isolated R2 smoke key: %v", err)
	}
	prefix := fmt.Sprintf("_previews/%s/revisions/.artifact-pages-cloudflare-smoke-%s/", siteID, hex.EncodeToString(randomPart))
	key := prefix + "object.json"

	backend, err := NewCloudflareBackend(t.Context(), CloudflareOptions{
		AccountID: accountID, Bucket: bucket, ZoneID: zoneID, PublicBaseURL: publicBaseURL,
		AccessKeyID: accessKeyID, SecretKey: secretAccessKey, SessionToken: sessionToken,
	})
	if err != nil {
		t.Fatalf("create Cloudflare R2 backend: %v", err)
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		t.Fatal("Cloudflare backend does not implement conditional object operations")
	}
	registered, err := loadOriginRegistry(t.Context(), conditional)
	if err != nil {
		t.Fatalf("read deployed registry from R2: %v", err)
	}
	if _, found := registrySite(registered, siteID); !found {
		t.Fatalf("Cloudflare smoke site %q is not present in the deployed registry", siteID)
	}

	cleanup := func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		keys, err := backend.ListKeys(ctx, prefix)
		if err != nil {
			return fmt.Errorf("list isolated R2 smoke objects for cleanup: %w", err)
		}
		if len(keys) == 0 {
			return nil
		}
		return backend.DeleteObjects(ctx, keys)
	}
	t.Cleanup(func() {
		if err := cleanup(); err != nil {
			t.Errorf("remove temporary Cloudflare R2 preview smoke objects: %v", err)
		}
	})

	initial := Object{
		Bytes: []byte(`{"phase":"created"}`), ContentType: "application/json", ContentDisposition: "inline",
		Cache: "no-store", Metadata: map[string]string{"smoke": "artifact-pages-preview"},
	}
	initialETag, err := conditional.PutObjectConditional(t.Context(), key, initial, ObjectCondition{IfNoneMatch: true})
	if err != nil {
		t.Fatalf("create R2 object with If-None-Match: *: %v", err)
	}
	if initialETag == "" {
		t.Fatal("R2 conditional create returned an empty ETag")
	}
	if _, err := conditional.PutObjectConditional(t.Context(), key, initial, ObjectCondition{IfNoneMatch: true}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("second If-None-Match create error = %v, want ErrPreconditionFailed", err)
	}
	if _, err := conditional.PutObjectConditional(t.Context(), key, Object{Bytes: []byte("stale")}, ObjectCondition{IfMatchETag: `"stale-etag"`}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale If-Match error = %v, want ErrPreconditionFailed", err)
	}

	info, err := conditional.HeadObject(t.Context(), key)
	if err != nil {
		t.Fatalf("read R2 preview object metadata: %v", err)
	}
	if info.ContentType != initial.ContentType || info.ContentDisposition != initial.ContentDisposition || info.ContentEncoding != "" || info.CacheControl != initial.Cache || info.Metadata["smoke"] != "artifact-pages-preview" {
		t.Fatalf("R2 preview object metadata = %+v; want content type, inline disposition, absent encoding, cache and user metadata", info)
	}
	read, readETag, err := conditional.GetObject(t.Context(), key)
	if err != nil {
		t.Fatalf("read R2 preview object bytes: %v", err)
	}
	if string(read.Bytes) != string(initial.Bytes) || readETag != initialETag {
		t.Fatalf("R2 preview object read = bytes %q ETag %q; want %q %q", read.Bytes, readETag, initial.Bytes, initialETag)
	}
	listed, err := backend.ListKeys(t.Context(), prefix)
	if err != nil {
		t.Fatalf("list isolated R2 preview smoke prefix: %v", err)
	}
	if len(listed) != 1 || listed[0] != key {
		t.Fatalf("listed R2 preview smoke prefix = %q; want only %q", listed, key)
	}

	updated := Object{Bytes: []byte(`{"phase":"compare-and-swap"}`), ContentType: "application/json", Cache: "no-store"}
	currentETag, err := conditional.PutObjectConditional(t.Context(), key, updated, ObjectCondition{IfMatchETag: initialETag})
	if err != nil {
		t.Fatalf("compare-and-swap R2 object with observed ETag: %v", err)
	}
	if currentETag == "" || currentETag == initialETag {
		t.Fatalf("R2 compare-and-swap ETag = %q; want a new non-empty ETag", currentETag)
	}

	type raceResult struct{ err error }
	start := make(chan struct{})
	results := make(chan raceResult, 2)
	for index := 0; index < 2; index++ {
		go func(index int) {
			<-start
			candidate := Object{Bytes: []byte(fmt.Sprintf(`{"writer":%d}`, index)), ContentType: "application/json", Cache: "no-store"}
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
			t.Fatalf("R2 conditional race returned unexpected error: %v", result.err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("R2 conditional race outcomes = %d success, %d conflict; want exactly one of each", successes, conflicts)
	}
}
