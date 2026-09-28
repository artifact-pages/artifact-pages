package publisher

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// TestLocalEdgeConformance runs the same object API checks against the adapter
// selected by the docker-compose.edge.yml profile. It is skipped in ordinary
// unit-test runs and enabled by scripts/run-edge-profile.mjs.
func TestLocalEdgeConformance(t *testing.T) {
	profile := os.Getenv("ARTIFACT_PAGES_EDGE_PROFILE")
	if profile == "" {
		t.Skip("set ARTIFACT_PAGES_EDGE_PROFILE to run against a local object emulator")
	}
	ctx := context.Background()
	var backend DeploymentBackend
	var err error
	switch profile {
	case "aws":
		backend, err = NewAWSBackend(ctx, AWSOptions{Region: "us-east-1", Bucket: "artifact-pages"})
	case "cloudflare":
		backend, err = NewCloudflareBackend(ctx, CloudflareOptions{
			AccountID: "0123456789abcdef0123456789abcdef", Bucket: "artifact-pages",
			ZoneID: "abcdef0123456789abcdef0123456789", PublicBaseURL: "https://pages.example.test",
			R2Endpoint: os.Getenv("EDGE_R2_ENDPOINT"), APIBaseURL: os.Getenv("EDGE_CF_API_BASE_URL"),
			AccessKeyID: os.Getenv("CF_R2_ACCESS_KEY_ID"), SecretKey: os.Getenv("CF_R2_SECRET_ACCESS_KEY"),
			APIToken: os.Getenv("CF_API_TOKEN"),
		})
	case "gcp":
		backend, err = NewLocalGCSBackend(os.Getenv("EDGE_GCS_ENDPOINT"), "artifact-pages")
	default:
		t.Fatalf("unknown ARTIFACT_PAGES_EDGE_PROFILE %q", profile)
	}
	if err != nil {
		t.Fatalf("create %s profile backend: %v", profile, err)
	}
	conditional, ok := backend.(ConditionalObjectBackend)
	if !ok {
		t.Fatalf("%s backend %T does not satisfy conditional object operations", profile, backend)
	}

	prefix := fmt.Sprintf("_conformance/%d/", time.Now().UnixNano())
	keys := make([]string, 1005)
	for index := range keys {
		keys[index] = fmt.Sprintf("%sobject-%04d.txt", prefix, index)
	}
	lockKey := prefix + "conditional.json"
	raceKey := prefix + "conditional-race.json"
	cleanupKeys := append(append([]string(nil), keys...), lockKey, raceKey)
	t.Cleanup(func() { _ = backend.DeleteObjects(context.Background(), cleanupKeys) })

	first, err := conditional.PutObjectConditional(ctx, lockKey, Object{Bytes: []byte("first"), ContentType: "application/json", Cache: "no-store"}, ObjectCondition{IfNoneMatch: true})
	if err != nil || first == "" {
		t.Fatalf("conditional create = (%q, %v), want generation", first, err)
	}
	if _, err := conditional.PutObjectConditional(ctx, lockKey, Object{Bytes: []byte("duplicate")}, ObjectCondition{IfNoneMatch: true}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("duplicate create error = %v, want ErrPreconditionFailed", err)
	}
	info, err := conditional.HeadObject(ctx, lockKey)
	if err != nil || info.ETag != first || info.ContentType != "application/json" {
		t.Fatalf("HeadObject() = %+v, %v; want conditional token and metadata", info, err)
	}
	stored, storedVersion, err := conditional.GetObject(ctx, lockKey)
	if err != nil || string(stored.Bytes) != "first" || storedVersion != first {
		t.Fatalf("GetObject() = %q, %q, %v; want first bytes and initial generation", stored.Bytes, storedVersion, err)
	}
	second, err := conditional.PutObjectConditional(ctx, lockKey, Object{Bytes: []byte("second")}, ObjectCondition{IfMatchETag: first})
	if err != nil || second == first {
		t.Fatalf("matching compare-and-swap = (%q, %v), want a new version", second, err)
	}
	if _, err := conditional.PutObjectConditional(ctx, lockKey, Object{Bytes: []byte("stale")}, ObjectCondition{IfMatchETag: first}); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale compare-and-swap error = %v, want ErrPreconditionFailed", err)
	}
	if _, _, err := conditional.GetObject(ctx, prefix+"missing"); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("missing object read error = %v, want ErrObjectNotFound", err)
	}

	// R2 is the only profile that has an explicit real-service conditional-write
	// smoke gate. Exercise the concurrent compare-and-swap path against the local
	// R2-shaped endpoint too, so the profile proves more than sequential ETag use.
	if profile == "cloudflare" {
		raceETag, err := conditional.PutObjectConditional(ctx, raceKey, Object{Bytes: []byte("base")}, ObjectCondition{IfNoneMatch: true})
		if err != nil || raceETag == "" {
			t.Fatalf("seed conditional race object = (%q, %v), want ETag", raceETag, err)
		}
		type raceResult struct {
			body string
			etag string
			err  error
		}
		start := make(chan struct{})
		results := make(chan raceResult, 2)
		for _, body := range []string{"writer-a", "writer-b"} {
			body := body
			go func() {
				<-start
				etag, err := conditional.PutObjectConditional(ctx, raceKey, Object{Bytes: []byte(body)}, ObjectCondition{IfMatchETag: raceETag})
				results <- raceResult{body: body, etag: etag, err: err}
			}()
		}
		close(start)
		var winners, conflicts int
		var winningBody string
		for range 2 {
			result := <-results
			switch {
			case result.err == nil:
				winners++
				winningBody = result.body
				if result.etag == "" || result.etag == raceETag {
					t.Errorf("conditional race winner ETag = %q, want a new non-empty ETag", result.etag)
				}
			case errors.Is(result.err, ErrPreconditionFailed):
				conflicts++
			default:
				t.Errorf("conditional race writer %s error = %v, want success or ErrPreconditionFailed", result.body, result.err)
			}
		}
		if winners != 1 || conflicts != 1 {
			t.Fatalf("conditional race results = %d winner(s), %d conflict(s); want exactly one of each", winners, conflicts)
		}
		stored, _, err := conditional.GetObject(ctx, raceKey)
		if err != nil || string(stored.Bytes) != winningBody {
			t.Fatalf("conditional race final object = %q, %v; want winning bytes %q", stored.Bytes, err, winningBody)
		}
	}

	for index, key := range keys {
		if err := backend.PutObject(ctx, key, Object{
			Bytes: []byte(fmt.Sprintf("object-%04d", index)), ContentType: "text/plain; charset=utf-8",
			Cache: "public, max-age=60", Metadata: map[string]string{"profile": profile},
		}); err != nil {
			t.Fatalf("PutObject(%s): %v", key, err)
		}
	}
	listed, err := backend.ListKeys(ctx, prefix+"object-")
	if err != nil {
		t.Fatalf("ListKeys(%q): %v", prefix, err)
	}
	sort.Strings(keys)
	if strings.Join(listed, "\n") != strings.Join(keys, "\n") {
		t.Fatalf("complete prefix listing returned %d objects, want %d", len(listed), len(keys))
	}
	if err := backend.DeleteObjects(ctx, keys); err != nil {
		t.Fatalf("batched DeleteObjects(%d): %v", len(keys), err)
	}
	remaining, err := backend.ListKeys(ctx, prefix+"object-")
	if err != nil || len(remaining) != 0 {
		t.Fatalf("ListKeys() after batched delete = %d objects, %v; want empty", len(remaining), err)
	}
	if err := backend.DeleteObjects(ctx, []string{lockKey}); err != nil {
		t.Fatalf("DeleteObjects(lock): %v", err)
	}
	if err := backend.DeleteObjects(ctx, nil); err != nil {
		t.Fatalf("DeleteObjects(empty): %v", err)
	}
	if _, err := backend.Invalidate(ctx, []string{"/" + strings.TrimPrefix(lockKey, "_")}); err != nil {
		t.Fatalf("Invalidate(valid local cache path): %v", err)
	}
}
