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
	"time"
)

const defaultLockWait = 10 * time.Second

var lockSiteIDPattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

type lockRecord struct {
	SchemaVersion int       `json:"schemaVersion"`
	Site          string    `json:"site"`
	State         string    `json:"state"`
	Owner         string    `json:"owner,omitempty"`
	AcquiredAt    time.Time `json:"acquiredAt,omitempty"`
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
	return manager.inspect(ctx, siteID, siteLockKey(siteID))
}

func (manager SiteLockManager) InspectRegistry(ctx context.Context) (LockSnapshot, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, errors.New("conditional deployment backend is required")
	}
	return manager.inspect(ctx, "registry", "_control/locks/registry.json")
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
	return manager.acquire(ctx, siteID, siteLockKey(siteID))
}

// AcquireRegistry serializes whole-registry updates separately from per-site
// publishing while keeping the same provider-neutral CAS record contract.
func (manager SiteLockManager) AcquireRegistry(ctx context.Context) (LockSnapshot, func() error, error) {
	if manager.Backend == nil {
		return LockSnapshot{}, nil, errors.New("conditional deployment backend is required")
	}
	return manager.acquire(ctx, "registry", "_control/locks/registry.json")
}

func (manager SiteLockManager) acquire(ctx context.Context, siteID, key string) (LockSnapshot, func() error, error) {
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
			freeBytes, marshalErr := marshalLockRecord(lockRecord{SchemaVersion: 1, Site: siteID, State: "free"})
			if marshalErr != nil {
				return LockSnapshot{}, nil, marshalErr
			}
			if lockWaitDeadlineReached(deadline.C) {
				return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
			}
			_, putErr := manager.Backend.PutObjectConditional(ctx, key, Object{Bytes: freeBytes, ContentType: "application/json; charset=utf-8"}, ObjectCondition{IfNoneMatch: true})
			if errors.Is(putErr, ErrPreconditionFailed) {
				timedOut, waitErr := waitForLockRetry(ctx, deadline.C, pollPeriod)
				if waitErr != nil {
					return LockSnapshot{}, nil, waitErr
				}
				if timedOut {
					return LockSnapshot{}, nil, fmt.Errorf("timed out waiting for site %q lock", siteID)
				}
			} else if putErr != nil {
				return LockSnapshot{}, nil, fmt.Errorf("initialize site lock: %w", putErr)
			}
			continue
		}
		if readErr != nil {
			return LockSnapshot{}, nil, fmt.Errorf("read site lock: %w", readErr)
		}
		record, decodeErr := decodeLockRecord(object.Bytes, siteID)
		if decodeErr != nil {
			return LockSnapshot{}, nil, decodeErr
		}
		if record.State == "free" {
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
			snapshot := snapshotFromRecord(record, newETag)
			return snapshot, func() error {
				releaseCtx, cancel := context.WithTimeout(context.Background(), defaultLockWait)
				defer cancel()
				return manager.release(releaseCtx, key, siteID, owner, newETag)
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
	return manager.recover(ctx, siteID, siteLockKey(siteID), observedETag)
}

func (manager SiteLockManager) RecoverRegistry(ctx context.Context, observedETag string) error {
	if manager.Backend == nil {
		return errors.New("conditional deployment backend is required")
	}
	return manager.recover(ctx, "registry", "_control/locks/registry.json", observedETag)
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

func (manager SiteLockManager) release(ctx context.Context, key, siteID, owner, etag string) error {
	object, currentETag, err := manager.Backend.GetObject(ctx, key)
	if err != nil {
		return fmt.Errorf("read site lock before release: %w", err)
	}
	if currentETag != etag {
		return ErrPreconditionFailed
	}
	record, err := decodeLockRecord(object.Bytes, siteID)
	if err != nil {
		return err
	}
	if record.State != "held" || record.Owner != owner {
		return errors.New("site lock ownership changed before release")
	}
	record.State, record.Owner, record.AcquiredAt = "free", "", time.Time{}
	contents, err := marshalLockRecord(record)
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

func siteLockKey(siteID string) string { return "_control/locks/sites/" + siteID + ".json" }

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
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
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
