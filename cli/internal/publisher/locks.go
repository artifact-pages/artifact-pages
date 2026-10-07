package publisher

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/artifact-pages/artifact-pages/cli/internal/compat"
)

const defaultLockWait = 10 * time.Second

var lockSiteIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type lockRecord struct {
	SchemaVersion int       `json:"schemaVersion"`
	Site          string    `json:"site"`
	State         string    `json:"state"`
	Owner         string    `json:"owner,omitempty"`
	AcquiredAt    time.Time `json:"acquiredAt,omitempty"`
	// LegacyAdopted is set once the pre-IMP-66 per-site records and lock were
	// adopted for this site (see adoptLegacySite). Absent means "not yet".
	LegacyAdopted bool `json:"legacyAdopted,omitempty"`
}

// LockSnapshot is a provider-neutral view of a retained per-site control lock.
type LockSnapshot struct {
	Site       string    `json:"site"`
	State      string    `json:"state"`
	Owner      string    `json:"owner,omitempty"`
	AcquiredAt time.Time `json:"acquiredAt,omitempty"`
	ETag       string    `json:"etag"`
}

// SiteLockManager coordinates publish and unregister through a retained
// compare-and-swap record outside the public content prefixes.
type SiteLockManager struct {
	Backend    ConditionalObjectBackend
	WaitLimit  time.Duration
	PollPeriod time.Duration
	Now        func() time.Time
}

func (manager SiteLockManager) Inspect(ctx context.Context, siteID string) (LockSnapshot, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, errors.New("conditional deployment backend is required")
	}
	if err := validateLockSite(siteID); err != nil {
		return LockSnapshot{}, err
	}
	snapshot, err := manager.inspect(ctx, siteID, siteLockKey(siteID))
	if err != nil || snapshot.State == "held" {
		return snapshot, err
	}
	// A pre-IMP-66 CLI may still hold the legacy lock record. Report it so an
	// operator can see and recover it with the same ETag workflow.
	legacy, legacyErr := manager.inspect(ctx, siteID, legacySiteLockKey(siteID))
	if legacyErr == nil && legacy.State == "held" {
		return legacy, nil
	}
	return snapshot, nil
}

func (manager SiteLockManager) InspectRegistry(ctx context.Context) (LockSnapshot, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, errors.New("conditional deployment backend is required")
	}
	return manager.inspect(ctx, "registry", registryLockKey)
}

// InspectApplication reads the retained lock that serializes application
// bundle deployments. It uses a fixed control identity, not a site ID.
func (manager SiteLockManager) InspectApplication(ctx context.Context) (LockSnapshot, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, errors.New("conditional deployment backend is required")
	}
	return manager.inspect(ctx, "application", applicationLockKey)
}

func (manager SiteLockManager) inspect(ctx context.Context, siteID, key string) (LockSnapshot, error) {
	object, etag, err := manager.Backend.GetObject(ctx, key)
	if errors.Is(err, ErrObjectNotFound) {
		return LockSnapshot{Site: siteID, State: "uninitialized"}, nil
	}
	if err != nil {
		return LockSnapshot{}, fmt.Errorf("read site lock: %w", err)
	}
	record, err := decodeLockRecord(object.Bytes, siteID)
	if err != nil {
		return LockSnapshot{}, err
	}
	return snapshotFromRecord(record, etag), nil
}

func (manager SiteLockManager) Acquire(ctx context.Context, siteID string) (LockSnapshot, func() error, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, nil, errors.New("conditional deployment backend is required")
	}
	if err := validateLockSite(siteID); err != nil {
		return LockSnapshot{}, nil, err
	}
	return manager.acquireWith(ctx, siteID, siteLockKey(siteID), manager.adoptLegacySite)
}

// AcquireRegistry serializes whole-registry updates separately from per-site
// publishing while keeping the same provider-neutral CAS record contract.
func (manager SiteLockManager) AcquireRegistry(ctx context.Context) (LockSnapshot, func() error, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, nil, errors.New("conditional deployment backend is required")
	}
	return manager.acquire(ctx, "registry", registryLockKey)
}

// AcquireApplication serializes application deployments across processes.
func (manager SiteLockManager) AcquireApplication(ctx context.Context) (LockSnapshot, func() error, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, nil, errors.New("conditional deployment backend is required")
	}
	return manager.acquire(ctx, "application", applicationLockKey)
}

func (manager SiteLockManager) acquire(ctx context.Context, siteID, key string) (LockSnapshot, func() error, error) {
	return manager.acquireWith(ctx, siteID, key, nil)
}

// acquireWith is acquire plus an optional adoption step. When adopt is set and
// the lock record does not yet say LegacyAdopted, adopt runs after the record
// is seen free (or absent) and before it is claimed, and the claiming write
// records LegacyAdopted so later acquisitions skip the step entirely.
func (manager SiteLockManager) acquireWith(ctx context.Context, siteID, key string, adopt func(context.Context, string) error) (LockSnapshot, func() error, error) {
	waitLimit := manager.WaitLimit
	if waitLimit <= 0 {
		waitLimit = defaultLockWait
	}
	pollPeriod := manager.PollPeriod
	if pollPeriod <= 0 {
		pollPeriod = 100 * time.Millisecond
	}
	deadline := time.NewTimer(waitLimit)
	defer deadline.Stop()
	owner, err := newLockOwner()
	if err != nil {
		return LockSnapshot{}, nil, err
	}
	for {
		if err := ctx.Err(); err != nil {
			return LockSnapshot{}, nil, err
		}
		if lockWaitDeadlineReached(deadline.C) {
			return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
		}
		object, etag, readErr := manager.Backend.GetObject(ctx, key)
		if errors.Is(readErr, ErrObjectNotFound) {
			record := lockRecord{
				SchemaVersion: 1,
				Site:          siteID,
				State:         "held",
				Owner:         owner,
				AcquiredAt:    manager.now().UTC(),
			}
			if adopt != nil {
				if err := adopt(ctx, siteID); err != nil {
					return LockSnapshot{}, nil, err
				}
				record.LegacyAdopted = true
			}
			contents, marshalErr := marshalLockRecord(record)
			if marshalErr != nil {
				return LockSnapshot{}, nil, marshalErr
			}
			if lockWaitDeadlineReached(deadline.C) {
				return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
			}
			newETag, putErr := manager.Backend.PutObjectConditional(ctx, key, Object{Bytes: contents, ContentType: "application/json; charset=utf-8"}, ObjectCondition{IfNoneMatch: true})
			if errors.Is(putErr, ErrPreconditionFailed) {
				timedOut, waitErr := waitForLockRetry(ctx, deadline.C, pollPeriod)
				if waitErr != nil {
					return LockSnapshot{}, nil, waitErr
				}
				if timedOut {
					return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
				}
				continue
			} else if putErr != nil {
				return LockSnapshot{}, nil, fmt.Errorf("acquire site lock: %w", putErr)
			}
			if strings.TrimSpace(newETag) == "" {
				return LockSnapshot{}, nil, fmt.Errorf("acquire site lock %q: conditional write returned no ETag; inspect the lock and recover it after confirming no operation is active", siteID)
			}
			return snapshotFromRecord(record, newETag), func() error {
				releaseCtx, cancel := context.WithTimeout(context.Background(), defaultLockWait)
				defer cancel()
				return manager.release(releaseCtx, key, siteID, record, newETag)
			}, nil
		}
		if readErr != nil {
			return LockSnapshot{}, nil, fmt.Errorf("read site lock: %w", readErr)
		}
		if strings.TrimSpace(etag) == "" {
			return LockSnapshot{}, nil, fmt.Errorf("site lock %q has no ETag for compare-and-swap", siteID)
		}
		record, decodeErr := decodeLockRecord(object.Bytes, siteID)
		if decodeErr != nil {
			return LockSnapshot{}, nil, decodeErr
		}
		if record.State == "free" {
			if adopt != nil && !record.LegacyAdopted {
				if err := adopt(ctx, siteID); err != nil {
					return LockSnapshot{}, nil, err
				}
				record.LegacyAdopted = true
			}
			record.State = "held"
			record.Owner = owner
			record.AcquiredAt = manager.now().UTC()
			contents, marshalErr := marshalLockRecord(record)
			if marshalErr != nil {
				return LockSnapshot{}, nil, marshalErr
			}
			if lockWaitDeadlineReached(deadline.C) {
				return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
			}
			newETag, putErr := manager.Backend.PutObjectConditional(ctx, key, Object{Bytes: contents, ContentType: "application/json; charset=utf-8"}, ObjectCondition{IfMatchETag: etag})
			if errors.Is(putErr, ErrPreconditionFailed) {
				timedOut, waitErr := waitForLockRetry(ctx, deadline.C, pollPeriod)
				if waitErr != nil {
					return LockSnapshot{}, nil, waitErr
				}
				if timedOut {
					return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
				}
				continue
			}
			if putErr != nil {
				return LockSnapshot{}, nil, fmt.Errorf("acquire site lock: %w", putErr)
			}
			if strings.TrimSpace(newETag) == "" {
				return LockSnapshot{}, nil, fmt.Errorf("acquire site lock %q: conditional write returned no ETag; inspect the lock and recover it after confirming no operation is active", siteID)
			}
			return snapshotFromRecord(record, newETag), func() error {
				releaseCtx, cancel := context.WithTimeout(context.Background(), defaultLockWait)
				defer cancel()
				return manager.release(releaseCtx, key, siteID, record, newETag)
			}, nil
		}
		if record.State != "held" {
			return LockSnapshot{}, nil, fmt.Errorf("site lock %q has invalid state %q", siteID, record.State)
		}
		timedOut, waitErr := waitForLockRetry(ctx, deadline.C, pollPeriod)
		if waitErr != nil {
			return LockSnapshot{}, nil, waitErr
		}
		if timedOut {
			return snapshotFromRecord(record, etag), nil, fmt.Errorf("timed out waiting for site %q lock held since %s", siteID, record.AcquiredAt.UTC().Format(time.RFC3339))
		}
	}
}

func waitForLockRetry(ctx context.Context, deadline <-chan time.Time, pollPeriod time.Duration) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	wait := time.NewTimer(pollPeriod)
	defer wait.Stop()
	select {
	case <-ctx.Done():
		return false, ctx.Err()
	case <-deadline:
		if err := ctx.Err(); err != nil {
			return false, err
		}
		return true, nil
	case <-wait.C:
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-deadline:
			return true, nil
		default:
			return false, nil
		}
	}
}

func lockWaitDeadlineReached(deadline <-chan time.Time) bool {
	select {
	case <-deadline:
		return true
	default:
		return false
	}
}

// Recover clears a held lock only if the operator's inspected ETag is still
// current. A newer owner's record therefore cannot be cleared accidentally.
func (manager SiteLockManager) Recover(ctx context.Context, siteID, observedETag string) error {
	if manager.Backend == nil {
		return errors.New("conditional deployment backend is required")
	}
	if err := validateLockSite(siteID); err != nil {
		return err
	}
	err := manager.recover(ctx, siteID, siteLockKey(siteID), observedETag)
	if err == nil {
		return nil
	}
	// The inspected snapshot may have come from the legacy record.
	if _, _, legacyReadErr := manager.Backend.GetObject(ctx, legacySiteLockKey(siteID)); legacyReadErr == nil {
		if legacyErr := manager.recover(ctx, siteID, legacySiteLockKey(siteID), observedETag); legacyErr == nil {
			return nil
		}
	}
	return err
}

func (manager SiteLockManager) RecoverRegistry(ctx context.Context, observedETag string) error {
	if manager.Backend == nil {
		return errors.New("conditional deployment backend is required")
	}
	return manager.recover(ctx, "registry", registryLockKey, observedETag)
}

// RecoverApplication frees a stale application deployment lock only when the
// ETag still matches the operator's inspection.
func (manager SiteLockManager) RecoverApplication(ctx context.Context, observedETag string) error {
	if manager.Backend == nil {
		return errors.New("conditional deployment backend is required")
	}
	return manager.recover(ctx, "application", applicationLockKey, observedETag)
}

func (manager SiteLockManager) recover(ctx context.Context, siteID, key, observedETag string) error {
	if observedETag == "" {
		return errors.New("observed lock ETag is required")
	}
	object, etag, err := manager.Backend.GetObject(ctx, key)
	if err != nil {
		return fmt.Errorf("read site lock: %w", err)
	}
	if etag != observedETag {
		return ErrPreconditionFailed
	}
	record, err := decodeLockRecord(object.Bytes, siteID)
	if err != nil {
		return err
	}
	if record.State != "held" {
		return fmt.Errorf("site lock %q is not held", siteID)
	}
	record.State, record.Owner, record.AcquiredAt = "free", "", time.Time{}
	contents, err := marshalLockRecord(record)
	if err != nil {
		return err
	}
	if _, err := manager.Backend.PutObjectConditional(ctx, key, Object{Bytes: contents, ContentType: "application/json; charset=utf-8"}, ObjectCondition{IfMatchETag: observedETag}); err != nil {
		if errors.Is(err, ErrPreconditionFailed) {
			return ErrPreconditionFailed
		}
		return fmt.Errorf("recover site lock: %w", err)
	}
	return nil
}

func (manager SiteLockManager) release(ctx context.Context, key, siteID string, held lockRecord, etag string) error {
	if strings.TrimSpace(etag) == "" {
		return fmt.Errorf("site lock %q has no ETag for compare-and-swap release", siteID)
	}
	if held.Site != siteID || held.State != "held" || held.Owner == "" || held.AcquiredAt.IsZero() {
		return errors.New("site lock ownership changed before release")
	}
	free := held
	free.State, free.Owner, free.AcquiredAt = "free", "", time.Time{}
	contents, err := marshalLockRecord(free)
	if err != nil {
		return err
	}
	if _, err := manager.Backend.PutObjectConditional(ctx, key, Object{Bytes: contents, ContentType: "application/json; charset=utf-8"}, ObjectCondition{IfMatchETag: etag}); err != nil {
		return fmt.Errorf("release site lock: %w", err)
	}
	return nil
}

func (manager SiteLockManager) now() time.Time {
	if manager.Now != nil {
		return manager.Now()
	}
	return time.Now()
}

func validateLockSite(siteID string) error {
	if !lockSiteIDPattern.MatchString(siteID) || siteID == "assets" {
		return fmt.Errorf("invalid site identifier %q", siteID)
	}
	return nil
}

func newLockOwner() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("create site lock owner token: %w", err)
	}
	return hex.EncodeToString(raw[:]), nil
}

func marshalLockRecord(record lockRecord) ([]byte, error) {
	return json.Marshal(record)
}

func decodeLockRecord(contents []byte, siteID string) (lockRecord, error) {
	var record lockRecord
	if err := compat.CheckSchemaVersion("site lock record", contents, 1); err != nil {
		return lockRecord{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	if err := decoder.Decode(&record); err != nil {
		return lockRecord{}, fmt.Errorf("decode site lock: %w", err)
	}
	if record.SchemaVersion != 1 || record.Site != siteID || (record.State != "free" && record.State != "held") || (record.State == "held" && (record.Owner == "" || record.AcquiredAt.IsZero())) || (record.State == "free" && (record.Owner != "" || !record.AcquiredAt.IsZero())) {
		return lockRecord{}, errors.New("site lock record is invalid")
	}
	return record, nil
}

func snapshotFromRecord(record lockRecord, etag string) LockSnapshot {
	return LockSnapshot{Site: record.Site, State: record.State, Owner: record.Owner, AcquiredAt: record.AcquiredAt, ETag: etag}
}

// legacyLockMovedState marks a legacy lock record that a post-IMP-66 CLI has
// retired. Its schemaVersion is 2, so an older CLI that still reads the
// legacy key fails with the standard "written by a newer major version,
// upgrade the CLI" message instead of publishing against state it no longer
// finds.
const legacyLockMovedState = "moved"

type legacyLockTombstone struct {
	SchemaVersion int    `json:"schemaVersion"`
	Site          string `json:"site"`
	State         string `json:"state"`
	MovedTo       string `json:"movedTo"`
}

// Lock transition rule (IMP-66). The first time a post-IMP-66 CLI claims a
// site's current lock record, it first retires the site's legacy lock:
//
//  1. No legacy lock record: the site was never locked by an older CLI, so
//     there is nothing to wait for or move. Done.
//  2. A live (schemaVersion 1) legacy record: take it with the ordinary
//     compare-and-swap protocol, waiting for an older CLI that holds it, so
//     no older publish is in flight while records move.
//  3. Move the per-site records (migrateLegacySiteControl).
//  4. Overwrite the held legacy lock with a schemaVersion 2 tombstone. An
//     older CLI that reads the legacy key then fails ("written by a newer
//     major version, upgrade the CLI") and cannot take the legacy lock, so
//     two CLI versions never both believe they hold the site lock.
//  5. The caller's claim of the current lock records LegacyAdopted, so
//     steady-state acquisitions cost nothing extra.
//
// A legacy key the credential may not access (the module dropped the old
// grants, so no older CLI can run either) counts as absent.
func (manager SiteLockManager) adoptLegacySite(ctx context.Context, siteID string) error {
	key := legacySiteLockKey(siteID)
	object, _, err := manager.Backend.GetObject(ctx, key)
	if err != nil {
		if legacyProbeAbsent(err) {
			return nil
		}
		return fmt.Errorf("read legacy site lock: %w", err)
	}
	if compat.CheckSchemaVersion("site lock record", object.Bytes, 1) != nil {
		// Retired by an earlier adoption that did not finish recording it.
		return migrateLegacySiteControl(ctx, manager.Backend, siteID)
	}
	held, release, err := manager.acquire(ctx, siteID, key)
	if err != nil {
		return fmt.Errorf("acquire legacy site lock (an older CLI may still be publishing; recover the lock by ETag if it is stale): %w", err)
	}
	if err := migrateLegacySiteControl(ctx, manager.Backend, siteID); err != nil {
		return errors.Join(err, release())
	}
	tombstone, err := json.Marshal(legacyLockTombstone{SchemaVersion: 2, Site: siteID, State: legacyLockMovedState, MovedTo: siteLockKey(siteID)})
	if err != nil {
		return errors.Join(err, release())
	}
	if _, err := manager.Backend.PutObjectConditional(ctx, key, Object{Bytes: tombstone, ContentType: "application/json; charset=utf-8"}, ObjectCondition{IfMatchETag: held.ETag}); err != nil {
		return errors.Join(fmt.Errorf("retire legacy site lock: %w", err), release())
	}
	return nil
}
