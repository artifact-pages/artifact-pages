package publisher

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type td11LockPutCall struct {
	key       string
	state     string
	condition ObjectCondition
	etag      string
	err       error
}

type td11CountingLockBackend struct {
	*lockMemoryBackend
	mu       sync.Mutex
	gets     int
	putCalls []td11LockPutCall
	putHook  func(context.Context, string, Object, ObjectCondition) (string, error, bool)
}

func newTD11CountingLockBackend() *td11CountingLockBackend {
	return &td11CountingLockBackend{lockMemoryBackend: newLockMemoryBackend()}
}

func (backend *td11CountingLockBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	backend.mu.Lock()
	backend.gets++
	backend.mu.Unlock()
	return backend.lockMemoryBackend.GetObject(ctx, key)
}

func (backend *td11CountingLockBackend) PutObjectConditional(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error) {
	var record lockRecord
	_ = json.Unmarshal(object.Bytes, &record)

	var etag string
	var err error
	handled := false
	if backend.putHook != nil {
		etag, err, handled = backend.putHook(ctx, key, object, condition)
	}
	if !handled {
		etag, err = backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
	}

	backend.mu.Lock()
	backend.putCalls = append(backend.putCalls, td11LockPutCall{
		key: key, state: record.State, condition: condition, etag: etag, err: err,
	})
	backend.mu.Unlock()
	return etag, err
}

func (backend *td11CountingLockBackend) callCounts() (int, []td11LockPutCall) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	return backend.gets, append([]td11LockPutCall(nil), backend.putCalls...)
}

func (backend *td11CountingLockBackend) resetCallCounts() {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.gets = 0
	backend.putCalls = nil
}

func td11LockManager(backend ConditionalObjectBackend) SiteLockManager {
	return SiteLockManager{
		Backend:    backend,
		WaitLimit:  2 * time.Second,
		PollPeriod: time.Millisecond,
		Now:        func() time.Time { return time.Date(2026, 10, 5, 12, 0, 0, 0, time.UTC) },
	}
}

func TestTD11ColdAndWarmLockCallCounts(t *testing.T) {
	backend := newTD11CountingLockBackend()
	manager := td11LockManager(backend)

	cold, releaseCold, err := manager.Acquire(context.Background(), "td11")
	if err != nil {
		t.Fatalf("cold Acquire() error = %v", err)
	}
	if cold.State != "held" || cold.ETag == "" || cold.Owner == "" {
		t.Fatalf("cold lock snapshot = %+v; want held record with owner and ETag", cold)
	}
	coldAcquireGets, coldAcquirePuts := backend.callCounts()
	if coldAcquireGets != 1 || len(coldAcquirePuts) != 1 {
		t.Fatalf("cold Acquire() calls = GET %d / conditional PUT %d; want 1 / 1", coldAcquireGets, len(coldAcquirePuts))
	}
	if err := releaseCold(); err != nil {
		t.Fatalf("cold release() error = %v", err)
	}
	gets, puts := backend.callCounts()
	if gets-coldAcquireGets != 0 || len(puts)-len(coldAcquirePuts) != 1 {
		t.Fatalf("cold release() delta = GET %+d / conditional PUT %+d; want 0 / 1", gets-coldAcquireGets, len(puts)-len(coldAcquirePuts))
	}
	if gets != 1 || len(puts) != 2 {
		t.Fatalf("cold Acquire()+release() calls = GET %d / conditional PUT %d; want 1 / 2", gets, len(puts))
	}
	if puts[0].key != siteLockKey("td11") || puts[0].state != "held" || !puts[0].condition.IfNoneMatch || puts[0].condition.IfMatchETag != "" || puts[0].err != nil {
		t.Fatalf("cold create call = %+v; want successful held If-None-Match on the site key", puts[0])
	}
	if puts[0].etag != cold.ETag || puts[1].state != "free" || puts[1].condition.IfNoneMatch || puts[1].condition.IfMatchETag != cold.ETag || puts[1].err != nil {
		t.Fatalf("cold release call = %+v; want free If-Match of acquired ETag %q", puts[1], cold.ETag)
	}

	backend.resetCallCounts()
	warm, releaseWarm, err := manager.Acquire(context.Background(), "td11")
	if err != nil {
		t.Fatalf("warm Acquire() error = %v", err)
	}
	if warm.State != "held" || warm.Owner == cold.Owner || warm.ETag == cold.ETag {
		t.Fatalf("warm lock snapshot = %+v; want a new held owner and ETag", warm)
	}
	warmAcquireGets, warmAcquirePuts := backend.callCounts()
	if warmAcquireGets != 1 || len(warmAcquirePuts) != 1 {
		t.Fatalf("warm Acquire() calls = GET %d / conditional PUT %d; want 1 / 1", warmAcquireGets, len(warmAcquirePuts))
	}
	if err := releaseWarm(); err != nil {
		t.Fatalf("warm release() error = %v", err)
	}
	gets, puts = backend.callCounts()
	if gets-warmAcquireGets != 0 || len(puts)-len(warmAcquirePuts) != 1 {
		t.Fatalf("warm release() delta = GET %+d / conditional PUT %+d; want 0 / 1", gets-warmAcquireGets, len(puts)-len(warmAcquirePuts))
	}
	if gets != 1 || len(puts) != 2 {
		t.Fatalf("warm Acquire()+release() calls = GET %d / conditional PUT %d; want 1 / 2", gets, len(puts))
	}
	if puts[0].state != "held" || puts[0].condition.IfNoneMatch || puts[0].condition.IfMatchETag == "" || puts[0].err != nil {
		t.Fatalf("warm acquire call = %+v; want held If-Match", puts[0])
	}
	if puts[1].state != "free" || puts[1].condition.IfNoneMatch || puts[1].condition.IfMatchETag != warm.ETag || puts[1].err != nil {
		t.Fatalf("warm release call = %+v; want free If-Match of acquired ETag %q", puts[1], warm.ETag)
	}
}

func TestTD11ConcurrentColdCreateHasOneWinner(t *testing.T) {
	backend := newTD11CountingLockBackend()
	const key = "_control/locks/sites/sre.json"
	barrier := newLockReadBarrier(2)
	backend.onMissingRead = func(readKey string) {
		if readKey == key {
			barrier.wait()
		}
	}
	backend.heldRead = make(chan struct{}, 2)
	manager := td11LockManager(backend)
	type result struct {
		snapshot LockSnapshot
		release  func() error
		err      error
	}
	results := make(chan result, 2)
	start := make(chan struct{})
	for range 2 {
		go func() {
			<-start
			snapshot, release, err := manager.Acquire(context.Background(), "sre")
			results <- result{snapshot: snapshot, release: release, err: err}
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
	select {
	case <-backend.heldRead:
	case <-time.After(time.Second):
		t.Fatal("losing contender did not observe the held lock")
	}
	select {
	case second := <-results:
		if second.release != nil {
			_ = second.release()
		}
		t.Fatalf("second Acquire() returned while first owner was held: %+v", second)
	default:
	}

	if err := first.release(); err != nil {
		t.Fatalf("first release() error = %v", err)
	}
	firstReleased = true
	second := <-results
	if second.err != nil {
		t.Fatalf("second Acquire() after first release error = %v", second.err)
	}
	if second.snapshot.Owner == first.snapshot.Owner || second.snapshot.State != "held" {
		t.Fatalf("second lock snapshot = %+v; want a distinct held owner", second.snapshot)
	}
	if err := second.release(); err != nil {
		t.Fatalf("second release() error = %v", err)
	}

	_, puts := backend.callCounts()
	var createSuccesses, createConflicts int
	for _, call := range puts {
		if !call.condition.IfNoneMatch {
			continue
		}
		if errors.Is(call.err, ErrPreconditionFailed) {
			createConflicts++
		} else if call.err == nil && call.state == "held" {
			createSuccesses++
		}
	}
	if createSuccesses != 1 || createConflicts != 1 {
		t.Fatalf("cold create outcomes = successes %d / precondition conflicts %d; want 1 / 1 (calls=%+v)", createSuccesses, createConflicts, puts)
	}
}

func TestTD11PersistedCreateErrorStopsBeforeOperationAndCanBeRecovered(t *testing.T) {
	backend := newTD11CountingLockBackend()
	injected := errors.New("create response lost after persistence")
	backend.putHook = func(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error, bool) {
		if !condition.IfNoneMatch {
			return "", nil, false
		}
		etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
		if err != nil {
			return etag, err, true
		}
		return "", injected, true
	}
	manager := td11LockManager(backend)
	operationMutations := 0
	snapshot, release, err := manager.Acquire(context.Background(), "sre")
	if err == nil {
		operationMutations++ // Models the caller's first mutation after successful acquisition.
	}
	if !errors.Is(err, injected) || release != nil || operationMutations != 0 {
		t.Fatalf("Acquire() = %+v, release nil=%t, mutations=%d, err=%v; want failure before mutation", snapshot, release == nil, operationMutations, err)
	}

	inspected, err := manager.Inspect(context.Background(), "sre")
	if err != nil || inspected.State != "held" || inspected.Owner == "" || inspected.ETag == "" {
		t.Fatalf("Inspect() after persisted error = %+v, %v; want held lock with recoverable ETag", inspected, err)
	}
	if err := manager.Recover(context.Background(), "sre", inspected.ETag); err != nil {
		t.Fatalf("Recover(exact inspected ETag) error = %v", err)
	}
	free, err := manager.Inspect(context.Background(), "sre")
	if err != nil || free.State != "free" || free.ETag == inspected.ETag {
		t.Fatalf("Inspect() after recovery = %+v, %v; want a new free version", free, err)
	}
}

func TestTD11BlankETagsFailClosed(t *testing.T) {
	t.Run("blank successful cold-create response", func(t *testing.T) {
		backend := newTD11CountingLockBackend()
		backend.putHook = func(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error, bool) {
			if !condition.IfNoneMatch {
				return "", nil, false
			}
			_, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
			return "", err, true
		}
		manager := td11LockManager(backend)
		_, release, err := manager.Acquire(context.Background(), "sre")
		if err == nil || !strings.Contains(err.Error(), "no ETag") || release != nil {
			t.Fatalf("Acquire() = release nil %t, err %v; want fail-closed blank ETag and no release closure", release == nil, err)
		}
		gets, puts := backend.callCounts()
		if gets != 1 || len(puts) != 1 || !puts[0].condition.IfNoneMatch {
			t.Fatalf("blank-create path calls = GET %d / PUT %+v; want one absent GET and one create only", gets, puts)
		}
		inspected, inspectErr := manager.Inspect(context.Background(), "sre")
		if inspectErr != nil || inspected.State != "held" || inspected.ETag == "" {
			t.Fatalf("Inspect() after blank write response = %+v, %v; want recoverable held lock", inspected, inspectErr)
		}
		if err := manager.Recover(context.Background(), "sre", inspected.ETag); err != nil {
			t.Fatalf("Recover(exact inspected ETag) error = %v", err)
		}
	})

	t.Run("blank read ETag", func(t *testing.T) {
		base := newLockMemoryBackend()
		freeBytes, err := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: "sre", State: "free"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := base.PutObjectConditional(context.Background(), siteLockKey("sre"), Object{Bytes: freeBytes}, ObjectCondition{IfNoneMatch: true}); err != nil {
			t.Fatal(err)
		}
		counting := &td11CountingLockBackend{lockMemoryBackend: base}
		blank := td11BlankLockReadBackend{td11CountingLockBackend: counting}
		_, release, err := td11LockManager(blank).Acquire(context.Background(), "sre")
		if err == nil || !strings.Contains(err.Error(), "no ETag") || release != nil {
			t.Fatalf("Acquire() = release nil %t, err %v; want fail-closed blank read ETag", release == nil, err)
		}
		gets, puts := counting.callCounts()
		if gets != 1 || len(puts) != 0 {
			t.Fatalf("blank-read calls = GET %d / PUT %d; want 1 / 0", gets, len(puts))
		}
	})
}

type td11BlankLockReadBackend struct {
	*td11CountingLockBackend
}

func (backend td11BlankLockReadBackend) GetObject(ctx context.Context, key string) (Object, string, error) {
	object, _, err := backend.td11CountingLockBackend.GetObject(ctx, key)
	return object, "  ", err
}

func TestTD11ReleasePersistedErrorDoesNotClobberOrRetryBlindly(t *testing.T) {
	backend := newTD11CountingLockBackend()
	manager := td11LockManager(backend)
	held, release, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("Acquire() error = %v", err)
	}
	injected := errors.New("release response lost after persistence")
	backend.putHook = func(ctx context.Context, key string, object Object, condition ObjectCondition) (string, error, bool) {
		var record lockRecord
		_ = json.Unmarshal(object.Bytes, &record)
		if record.State != "free" || condition.IfMatchETag != held.ETag {
			return "", nil, false
		}
		etag, err := backend.lockMemoryBackend.PutObjectConditional(ctx, key, object, condition)
		if err != nil {
			return etag, err, true
		}
		return "", injected, true
	}
	getsBefore, putsBefore := backend.callCounts()
	if err := release(); !errors.Is(err, injected) {
		t.Fatalf("release() error = %v; want persisted response error", err)
	}
	getsAfter, putsAfter := backend.callCounts()
	if getsAfter != getsBefore || len(putsAfter) != len(putsBefore)+1 {
		t.Fatalf("release calls changed GET %d→%d and PUT %d→%d; want zero GET and one conditional PUT", getsBefore, getsAfter, len(putsBefore), len(putsAfter))
	}
	if !errors.Is(putsAfter[len(putsAfter)-1].err, injected) || putsAfter[len(putsAfter)-1].condition.IfMatchETag != held.ETag {
		t.Fatalf("persisted release call = %+v; want acquired ETag and injected error", putsAfter[len(putsAfter)-1])
	}

	object, currentETag, getErr := backend.lockMemoryBackend.GetObject(context.Background(), siteLockKey("sre"))
	if getErr != nil {
		t.Fatalf("read persisted release state: %v", getErr)
	}
	free, decodeErr := decodeLockRecord(object.Bytes, "sre")
	if decodeErr != nil || free.State != "free" || currentETag == held.ETag {
		t.Fatalf("persisted release record = %+v, ETag %q, err %v; want a new free version", free, currentETag, decodeErr)
	}
	if err := release(); !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("retry of old release closure = %v; want ETag precondition failure", err)
	}
	objectAfter, etagAfter, getErr := backend.lockMemoryBackend.GetObject(context.Background(), siteLockKey("sre"))
	if getErr != nil {
		t.Fatalf("read after stale release retry: %v", getErr)
	}
	if etagAfter != currentETag {
		t.Fatalf("stale release changed ETag %q to %q", currentETag, etagAfter)
	}
	freeAfter, decodeErr := decodeLockRecord(objectAfter.Bytes, "sre")
	if decodeErr != nil || freeAfter.State != "free" {
		t.Fatalf("record after stale release retry = %+v, err %v; want unchanged free record", freeAfter, decodeErr)
	}
}

func TestTD11ReleaseAfterRecoveryOrNewOwnerCannotClobber(t *testing.T) {
	backend := newTD11CountingLockBackend()
	manager := td11LockManager(backend)
	oldOwner, releaseOld, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("old owner Acquire() error = %v", err)
	}
	if err := manager.Recover(context.Background(), "sre", oldOwner.ETag); err != nil {
		t.Fatalf("Recover(old owner ETag) error = %v", err)
	}
	newOwner, releaseNew, err := manager.Acquire(context.Background(), "sre")
	if err != nil {
		t.Fatalf("new owner Acquire() error = %v", err)
	}
	if newOwner.Owner == oldOwner.Owner || newOwner.ETag == oldOwner.ETag {
		t.Fatalf("new owner snapshot = %+v; want a distinct owner and ETag", newOwner)
	}

	getsBefore, putsBefore := backend.callCounts()
	err = releaseOld()
	getsAfter, putsAfter := backend.callCounts()
	if !errors.Is(err, ErrPreconditionFailed) {
		t.Fatalf("old release() = %v; want ETag precondition failure", err)
	}
	if getsAfter != getsBefore || len(putsAfter) != len(putsBefore)+1 {
		t.Fatalf("old release calls changed GET %d→%d and PUT %d→%d; want no GET and one fenced PUT", getsBefore, getsAfter, len(putsBefore), len(putsAfter))
	}
	if putsAfter[len(putsAfter)-1].condition.IfMatchETag != oldOwner.ETag || !errors.Is(putsAfter[len(putsAfter)-1].err, ErrPreconditionFailed) {
		t.Fatalf("stale release attempt = %+v; want CAS with old ETag and conflict", putsAfter[len(putsAfter)-1])
	}

	object, etag, readErr := backend.lockMemoryBackend.GetObject(context.Background(), siteLockKey("sre"))
	if readErr != nil {
		t.Fatalf("read new owner lock: %v", readErr)
	}
	current, decodeErr := decodeLockRecord(object.Bytes, "sre")
	if decodeErr != nil || current.State != "held" || current.Owner != newOwner.Owner || etag != newOwner.ETag {
		t.Fatalf("record after stale release = %+v, ETag %q, err %v; want new owner unchanged", current, etag, decodeErr)
	}
	if err := releaseNew(); err != nil {
		t.Fatalf("new owner release() error = %v", err)
	}
}

func TestTD11SiteRegistryApplicationAndNeighborScopesRemainIsolated(t *testing.T) {
	backend := newTD11CountingLockBackend()
	manager := td11LockManager(backend)
	type heldLock struct {
		name     string
		key      string
		site     string
		snapshot LockSnapshot
		release  func() error
	}
	var locks []heldLock
	acquire := func(name, key, site string, fn func() (LockSnapshot, func() error, error)) {
		t.Helper()
		snapshot, release, err := fn()
		if err != nil {
			t.Fatalf("acquire %s: %v", name, err)
		}
		locks = append(locks, heldLock{name: name, key: key, site: site, snapshot: snapshot, release: release})
	}
	acquire("site application", siteLockKey("application"), "application", func() (LockSnapshot, func() error, error) {
		return manager.Acquire(context.Background(), "application")
	})
	acquire("application scope", "_control/locks/application.json", "application", func() (LockSnapshot, func() error, error) {
		return manager.AcquireApplication(context.Background())
	})
	acquire("site registry", siteLockKey("registry"), "registry", func() (LockSnapshot, func() error, error) {
		return manager.Acquire(context.Background(), "registry")
	})
	acquire("registry scope", "_control/locks/registry.json", "registry", func() (LockSnapshot, func() error, error) {
		return manager.AcquireRegistry(context.Background())
	})
	acquire("neighbor site", siteLockKey("docs"), "docs", func() (LockSnapshot, func() error, error) {
		return manager.Acquire(context.Background(), "docs")
	})
	t.Cleanup(func() {
		for i := len(locks) - 1; i >= 0; i-- {
			_ = locks[i].release()
		}
	})

	seenKeys := make(map[string]bool)
	seenOwners := make(map[string]bool)
	for _, lock := range locks {
		if seenKeys[lock.key] || seenOwners[lock.snapshot.Owner] {
			t.Fatalf("scope identity collision at %s: %+v", lock.name, lock)
		}
		seenKeys[lock.key], seenOwners[lock.snapshot.Owner] = true, true
		object, etag, err := backend.lockMemoryBackend.GetObject(context.Background(), lock.key)
		if err != nil {
			t.Fatalf("read %s key %s: %v", lock.name, lock.key, err)
		}
		record, err := decodeLockRecord(object.Bytes, lock.site)
		if err != nil || record.State != "held" || record.Owner != lock.snapshot.Owner || etag != lock.snapshot.ETag {
			t.Fatalf("%s record at %s = %+v, ETag %q, err %v; want isolated held owner", lock.name, lock.key, record, etag, err)
		}
	}
	if len(seenKeys) != 5 {
		t.Fatalf("distinct lock keys = %d; want site, registry, application, and neighbor scopes", len(seenKeys))
	}
}
