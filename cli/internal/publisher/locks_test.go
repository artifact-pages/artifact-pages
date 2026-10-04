package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSiteLockConcurrentFirstCreationAndSameSiteExclusion(t *testing.T) {
	backend := newLockMemoryBackend()
	const key = "_control/locks/sites/sre.json"
	initialReads := newLockReadBarrier(2)
	backend.onMissingRead = func(readKey string) {
		if readKey == key {
			initialReads.wait()
		}
	}
	backend.heldRead = make(chan struct{}, 2)
	manager := SiteLockManager{Backend: backend, WaitLimit: 2 * time.Second, PollPeriod: time.Millisecond}
	type acquireResult struct {
		snapshot LockSnapshot
		release  func() error
		err      error
	}
	results := make(chan acquireResult, 2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			<-start
			snapshot, release, err := manager.Acquire(context.Background(), "sre")
			results <- acquireResult{snapshot: snapshot, release: release, err: err}
		}()
	}
	close(start)

	first := <-results
	if first.err != nil {
		t.Fatalf("first Acquire() error = %v", first.err)
	}
	firstReleased := false
	t.Cleanup(func() {
		if !firstReleased {
			_ = first.release()
		}
	})
	if first.snapshot.State != "held" || first.snapshot.ETag == "" {
		t.Fatalf("first lock snapshot = %+v, want held lock with ETag", first.snapshot)
	}
	select {
	case <-backend.heldRead:
	case <-time.After(time.Second):
		t.Fatal("second acquire did not observe the held lock")
	}
	select {
	case second := <-results:
		if second.release != nil {
			_ = second.release()
		}
		t.Fatalf("second same-site Acquire() returned before first release: %+v", second)
	default:
	}

	if err := first.release(); err != nil {
		t.Fatalf("first release() error = %v", err)
	}
	firstReleased = true
	second := <-results
	if second.err != nil {
		t.Fatalf("second Acquire() after release error = %v", second.err)
	}
	if second.snapshot.State != "held" || second.snapshot.Owner == first.snapshot.Owner {
		t.Fatalf("second lock snapshot = %+v, want a new held owner", second.snapshot)
	}
	if err := second.release(); err != nil {
		t.Fatalf("second release() error = %v", err)
	}

	keys, err := backend.ListKeys(context.Background(), "_control/locks/")
	if err != nil || len(keys) != 1 || keys[0] != key {
		t.Fatalf("retained lock keys = %v, err=%v", keys, err)
	}
}

func TestSiteLocksAllowIndependentSitesConcurrently(t *testing.T) {
	backend := newLockMemoryBackend()
	manager := SiteLockManager{Backend: backend, WaitLimit: time.Second, PollPeriod: time.Millisecond}
	first, releaseFirst, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("Acquire(sre) error = %v", err)
	}
	defer func() { _ = releaseFirst() }()
	second, releaseSecond, err := manager.Acquire(context.Background(), "docs")
	if err != nil {
		t.Fatalf("Acquire(docs) while sre held error = %v", err)
	}
	defer func() { _ = releaseSecond() }()
	if first.State != "held" || second.State != "held" || first.Owner == second.Owner || first.ETag == second.ETag {
		t.Fatalf("independent lock snapshots = %+v and %+v", first, second)
	}
	keys, err := backend.ListKeys(context.Background(), "_control/locks/sites/")
	if err != nil || len(keys) != 2 || keys[0] == keys[1] {
		t.Fatalf("per-site lock keys = %v, err=%v", keys, err)
	}
}

func TestApplicationLockHasFixedIdentityAndGuardedRecovery(t *testing.T) {
	backend := newLockMemoryBackend()
	manager := SiteLockManager{Backend: backend, WaitLimit: time.Second, PollPeriod: time.Millisecond}

	initial, err := manager.InspectApplication(context.Background())
	if err != nil || initial.Site != "application" || initial.State != "uninitialized" {
		t.Fatalf("InspectApplication() = %+v, %v; want uninitialized application lock", initial, err)
	}
	held, release, err := manager.AcquireApplication(context.Background())
	if err != nil {
		t.Fatalf("AcquireApplication() error = %v", err)
	}
	if held.Site != "application" || held.State != "held" || held.ETag == "" {
		t.Fatalf("application lock snapshot = %+v; want held application lock", held)
	}
	if _, _, err := backend.GetObject(context.Background(), "_control/locks/application.json"); err != nil {
		t.Fatalf("application lock key missing: %v", err)
	}
	if _, _, err := backend.GetObject(context.Background(), siteLockKey("application")); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("application scope collided with site ID key: %v", err)
	}

	if err := manager.RecoverApplication(context.Background(), "stale-etag"); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("RecoverApplication(stale ETag) = %v; want conditional conflict", err)
	}
	if err := manager.RecoverApplication(context.Background(), held.ETag); err != nil {
		t.Fatalf("RecoverApplication(observed ETag) error = %v", err)
	}
	free, err := manager.InspectApplication(context.Background())
	if err != nil || free.Site != "application" || free.State != "free" || free.ETag == held.ETag {
		t.Fatalf("application lock after recovery = %+v, %v; want free with new ETag", free, err)
	}
	if err := release(); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("old owner release after guarded recovery = %v; want fencing conflict", err)
	}
}

func TestLockAcquireRejectsExistingRecordWithoutETag(t *testing.T) {
	inner := newLockMemoryBackend()
	freeBytes, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: "application", State: "free"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := inner.PutObjectConditional(context.Background(), "_control/locks/application.json", Object{Bytes: freeBytes}, ObjectCondition{IfNoneMatch: true}); err != nil {
		t.Fatalf("seed application lock: %v", err)
	}
	backend := &blankETagLockBackend{lockMemoryBackend: inner}
	if _, release, err := (SiteLockManager{Backend: backend}).AcquireApplication(context.Background()); err == nil {
		if release != nil {
			_ = release()
		}
		t.Fatal("AcquireApplication() succeeded with an existing object and blank ETag")
	} else if !strings.Contains(err.Error(), "no ETag") {
		t.Fatalf("AcquireApplication() error = %v; want fail-closed ETag error", err)
	}
	inner.mu.Lock()
	defer inner.mu.Unlock()
	var record lockRecord
	if err := json.Unmarshal(inner.objects["_control/locks/application.json"].Bytes, &record); err != nil || record.State != "free" {
		t.Fatalf("lock after blank-ETag refusal = %+v, %v; want unchanged free state", record, err)
	}
}

type blankETagLockBackend struct {
	*lockMemoryBackend
}

func (backend *blankETagLockBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	object, _, err := backend.lockMemoryBackend.GetObject(ctx, key)
	if err != nil {
		return Object{}, "", err
	}
	return object, "  ", nil
}

func TestLockCASConflictsRespectWaitLimitForSiteAndRegistry(t *testing.T) {
	const waitLimit = 60 * time.Millisecond
	const pollPeriod = 10 * time.Millisecond

	for _, test := range []struct {
		name         string
		registry     bool
		seedFreeLock bool
	}{
		{name: "site initialization conflict"},
		{name: "site acquire conflict", seedFreeLock: true},
		{name: "registry initialization conflict", registry: true},
		{name: "registry acquire conflict", registry: true, seedFreeLock: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			inner := newLockMemoryBackend()
			siteID := "sre"
			lockKey := siteLockKey(siteID)
			if test.registry {
				siteID = "registry"
				lockKey = "_control/locks/registry.json"
			}
			if test.seedFreeLock {
				freeBytes, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: siteID, State: "free"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := inner.PutObjectConditional(context.Background(), lockKey, Object{Bytes: freeBytes}, ObjectCondition{IfNoneMatch: true}); err != nil {
					t.Fatalf("seed free lock: %v", err)
				}
			}
			backend := &alwaysConflictingLockBackend{lockMemoryBackend: inner}
			manager := SiteLockManager{Backend: backend, WaitLimit: waitLimit, PollPeriod: pollPeriod}

			started := time.Now()
			var snapshot LockSnapshot
			var release func() error
			var err error
			if test.registry {
				snapshot, release, err = manager.AcquireRegistry(context.Background())
			} else {
				snapshot, release, err = manager.Acquire(context.Background(), siteID)
			}
			elapsed := time.Since(started)
			if release != nil {
				_ = release()
			}
			if err == nil || !strings.Contains(err.Error(), "timed out waiting for site") {
				t.Fatalf("Acquire() = snapshot %+v, err %v; want bounded lock-wait timeout", snapshot, err)
			}
			if elapsed < waitLimit-10*time.Millisecond || elapsed > waitLimit+200*time.Millisecond {
				t.Fatalf("Acquire() returned after %s; want approximately the %s wait limit", elapsed, waitLimit)
			}
			if attempts := backend.writeAttempts(); attempts < 2 || attempts > 8 {
				t.Fatalf("conditional-write attempts = %d; want bounded retries with %s polling", attempts, pollPeriod)
			}
		})
	}
}

func TestLockCASConflictHonorsCallerCancellation(t *testing.T) {
	backend := &alwaysConflictingLockBackend{
		lockMemoryBackend: newLockMemoryBackend(),
		firstAttempt:      make(chan struct{}),
	}
	manager := SiteLockManager{Backend: backend, WaitLimit: 2 * time.Second, PollPeriod: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		_, release, err := manager.Acquire(ctx, "sre")
		if release != nil {
			_ = release()
		}
		result <- err
	}()

	select {
	case <-backend.firstAttempt:
	case <-time.After(time.Second):
		t.Fatal("Acquire() did not attempt the conditional lock write")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Acquire() error = %v; want caller cancellation", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Acquire() did not stop promptly after caller cancellation")
	}
	if attempts := backend.writeAttempts(); attempts != 1 {
		t.Fatalf("conditional-write attempts after cancellation = %d; want 1", attempts)
	}
}

func TestInterruptedSiteLockWaitsUntilGuardedRecovery(t *testing.T) {
	backend := newLockMemoryBackend()
	manager := SiteLockManager{Backend: backend, WaitLimit: time.Second, PollPeriod: time.Millisecond}
	interrupted, _, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	if interrupted.State != "held" || interrupted.ETag == "" {
		t.Fatalf("interrupted lock = %+v, want held lock with ETag", interrupted)
	}
	// The discarded release function models a process exiting before cleanup.

	const waitLimit = 60 * time.Millisecond
	waiter := SiteLockManager{Backend: backend, WaitLimit: waitLimit, PollPeriod: 10 * time.Millisecond}
	started := time.Now()
	snapshot, release, err := waiter.Acquire(context.Background(), "sre")
	elapsed := time.Since(started)
	if err == nil {
		_ = release()
		t.Fatal("Acquire() stole an interrupted held lock")
	}
	if elapsed < waitLimit-10*time.Millisecond || elapsed > waitLimit+200*time.Millisecond {
		t.Fatalf("Acquire() returned after %s; want approximately the %s wait limit", elapsed, waitLimit)
	}
	if snapshot.State != "held" || snapshot.Owner != interrupted.Owner || snapshot.ETag != interrupted.ETag {
		t.Fatalf("timed-out lock snapshot = %+v, want original held owner", snapshot)
	}

	inspected, err := manager.Inspect(context.Background(), "sre")
	if err != nil || inspected.State != "held" || inspected.ETag != interrupted.ETag {
		t.Fatalf("Inspect() = %+v, err=%v; want retained interrupted lock", inspected, err)
	}
	if err := manager.Recover(context.Background(), "sre", inspected.ETag); err != nil {
		t.Fatalf("Recover() with current inspected ETag error = %v", err)
	}
	recovered, err := manager.Inspect(context.Background(), "sre")
	if err != nil || recovered.State != "free" || recovered.ETag == inspected.ETag {
		t.Fatalf("Inspect() after recovery = %+v, err=%v; want a new free record", recovered, err)
	}
	_, release, err = manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("Acquire() after guarded recovery error = %v", err)
	}
	if err := release(); err != nil {
		t.Fatalf("release after recovery error = %v", err)
	}
}

func TestSiteLockRecoveryRejectsChangedETagAndRecoveryRace(t *testing.T) {
	backend := newLockMemoryBackend()
	manager := SiteLockManager{Backend: backend, WaitLimit: time.Second, PollPeriod: time.Millisecond}
	first, releaseFirst, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("first Acquire() error = %v", err)
	}
	if err := releaseFirst(); err != nil {
		t.Fatalf("first release() error = %v", err)
	}
	newOwner, releaseNewOwner, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("second Acquire() error = %v", err)
	}
	// Recovery below models an operator clearing the newer held record.
	if newOwner.ETag == first.ETag {
		t.Fatalf("lock ETag did not change across owners: %q", newOwner.ETag)
	}
	if err := manager.Recover(context.Background(), "sre", first.ETag); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("Recover(stale ETag) error = %v, want ErrPreconditionFailed", err)
	}
	current, err := manager.Inspect(context.Background(), "sre")
	if err != nil || current.State != "held" || current.Owner != newOwner.Owner || current.ETag != newOwner.ETag {
		t.Fatalf("stale recovery changed newer lock: snapshot=%+v err=%v", current, err)
	}

	// Both recoverers read the same held ETag before either performs its CAS.
	barrier := newLockReadBarrier(2)
	backend.afterRead = func(readKey string) {
		if readKey == siteLockKey("sre") {
			barrier.wait()
		}
	}
	recoveryResults := make(chan error, 2)
	for range 2 {
		go func() { recoveryResults <- manager.Recover(context.Background(), "sre", newOwner.ETag) }()
	}
	firstRecovery, secondRecovery := <-recoveryResults, <-recoveryResults
	if !((firstRecovery == nil && errors.Is(secondRecovery, ErrPreconditionFailed)) ||
		(firstRecovery != nil && errors.Is(firstRecovery, ErrPreconditionFailed) && secondRecovery == nil)) {
		t.Fatalf("concurrent recovery results = %v and %v; want one CAS winner", firstRecovery, secondRecovery)
	}
	final, err := manager.Inspect(context.Background(), "sre")
	if err != nil || final.State != "free" || final.ETag == newOwner.ETag {
		t.Fatalf("Inspect() after recovery race = %+v, err=%v; want one free transition", final, err)
	}
	if err := releaseNewOwner(); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("stale owner release() error = %v, want ErrPreconditionFailed", err)
	}
	stillFree, err := manager.Inspect(context.Background(), "sre")
	if err != nil || stillFree.State != "free" || stillFree.ETag != final.ETag {
		t.Fatalf("stale release changed recovered lock: snapshot=%+v err=%v", stillFree, err)
	}
}

type lockMemoryBackend struct {
	*memoryDeploymentBackend
	mu            sync.Mutex
	etags         map[string]string
	version       uint64
	onMissingRead func(string)
	afterRead     func(string)
	heldRead      chan struct{}
}

type alwaysConflictingLockBackend struct {
	*lockMemoryBackend
	attemptMu    sync.Mutex
	attempts     int
	firstAttempt chan struct{}
}

func (backend *alwaysConflictingLockBackend) PutObjectConditional(ctx context.Context, _ string, _ Object, _ ObjectCondition) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	backend.attemptMu.Lock()
	backend.attempts++
	if backend.attempts == 1 && backend.firstAttempt != nil {
		close(backend.firstAttempt)
	}
	backend.attemptMu.Unlock()
	return "", ErrPreconditionFailed
}

func (backend *alwaysConflictingLockBackend) writeAttempts() int {
	backend.attemptMu.Lock()
	defer backend.attemptMu.Unlock()
	return backend.attempts
}

func newLockMemoryBackend() *lockMemoryBackend {
	return &lockMemoryBackend{
		memoryDeploymentBackend: &memoryDeploymentBackend{objects: make(map[string]Object)},
		etags:                   make(map[string]string),
	}
}

func (backend *lockMemoryBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	if err := ctx.Err(); err != nil {
		return Object{}, "", err
	}
	backend.mu.Lock()
	object, ok := backend.objects[key]
	etag := backend.etags[key]
	object.Bytes = append([]byte(nil), object.Bytes...)
	var state string
	if ok {
		var record lockRecord
		_ = json.Unmarshal(object.Bytes, &record)
		state = record.State
	}
	backend.mu.Unlock()

	if !ok {
		if backend.onMissingRead != nil {
			backend.onMissingRead(key)
		}
		return Object{}, "", ErrObjectNotFound
	}
	if state == "held" && backend.heldRead != nil {
		select {
		case backend.heldRead <- struct{}{}:
		default:
		}
	}
	if backend.afterRead != nil {
		backend.afterRead(key)
	}
	return object, etag, nil
}

func (backend *lockMemoryBackend) HeadObject(ctx context.Context, key string) (ObjectInfo, error) {
	object, etag, err := backend.GetObject(ctx, key)
	if err != nil {
		return ObjectInfo{}, err
	}
	return ObjectInfo{
		ETag: etag, Size: int64(len(object.Bytes)), ContentType: object.ContentType,
		ContentDisposition: object.ContentDisposition, ContentEncoding: object.ContentEncoding,
		CacheControl: object.Cache,
		Metadata:     object.Metadata,
	}, nil
}

func (backend *lockMemoryBackend) PutObject(ctx context.Context, key string, object Object) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	object.Bytes = append([]byte(nil), object.Bytes...)
	backend.objects[key] = object
	backend.puts = append(backend.puts, key)
	return nil
}

func (backend *lockMemoryBackend) ListKeys(ctx context.Context, prefix string) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	var keys []string
	for key := range backend.objects {
		if strings.HasPrefix(key, prefix) {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys, nil
}

func (backend *lockMemoryBackend) DeleteObjects(ctx context.Context, keys []string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	for _, key := range keys {
		delete(backend.objects, key)
	}
	return nil
}

func (backend *lockMemoryBackend) Invalidate(ctx context.Context, paths []string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.invalidations = append(backend.invalidations, append([]string(nil), paths...))
	return "memory-revalidation", nil
}

func (backend *lockMemoryBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if condition.IfNoneMatch == (condition.IfMatchETag != "") {
		return "", errors.New("exactly one conditional-write precondition is required")
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	_, exists := backend.objects[key]
	currentETag := backend.etags[key]
	if condition.IfNoneMatch && exists || condition.IfMatchETag != "" && (!exists || currentETag != condition.IfMatchETag) {
		return "", ErrPreconditionFailed
	}
	backend.version++
	etag := fmt.Sprintf("\"lock-test-%d\"", backend.version)
	object.Bytes = append([]byte(nil), object.Bytes...)
	backend.objects[key], backend.etags[key] = object, etag
	return etag, nil
}

type lockReadBarrier struct {
	target   int
	arrived  int
	mu       sync.Mutex
	once     sync.Once
	released chan struct{}
}

func newLockReadBarrier(target int) *lockReadBarrier {
	return &lockReadBarrier{target: target, released: make(chan struct{})}
}

func (barrier *lockReadBarrier) wait() {
	barrier.mu.Lock()
	barrier.arrived++
	if barrier.arrived >= barrier.target {
		barrier.once.Do(func() { close(barrier.released) })
	}
	barrier.mu.Unlock()
	<-barrier.released
}
