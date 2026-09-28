# Enforce the lock wait limit during conditional-write conflicts

- Status: Open
- Priority: P2
- Area: Publisher coordination / locks
- Review: 2026-09-28, finding 08, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-22](../implementation/IMP-22-site-locks.md), [T5](../verification/T5-concurrency-recovery.md)

## Problem

A conditional-write precondition failure retries immediately without checking the wait deadline. Repeated acquire/release races bypass the documented wait limit and can loop indefinitely when the caller has no deadline.

## Evidence and reproduction

1. Use a deterministic store that repeatedly changes the lock between read and conditional write.
2. Acquire with WaitLimit of 10 ms and a caller context of 100 ms.
3. The review observed retries continuing until the caller's 100 ms deadline rather than the lock limit.

Reviewed source: [internal/publisher/locks.go:143](../../../internal/publisher/locks.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/storage-evidence.log / TestReviewLockConflictTimeout`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Every lock-acquisition retry is bounded and cancellation-aware, including compare-and-swap conflicts.

## Acceptance criteria

- [ ] A repeated CAS-conflict regression terminates at the configured wait bound within test tolerance, even without a caller deadline.
- [ ] Conflict retries do not busy-spin; held-lock and conditional-write paths obey the same bounded wait contract.
- [ ] Caller cancellation still terminates promptly, and races cannot release or overwrite a newer owner's lock.
- [ ] Cover both registry and site lock scopes without weakening independent-site concurrency or guarded recovery.
