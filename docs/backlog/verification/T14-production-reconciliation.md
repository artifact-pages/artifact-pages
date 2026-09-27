# T14 — Production reconciliation and race safety

- Status: Open
- Phase: Provider-backed deployment

## Proof needed

- [x] Test both normal site publish/unregister lock orderings with a deterministic local backend.
- [x] Verify separate site IDs can hold their own locks concurrently; this proves lock isolation, not concurrent `PublishSite` calls.
- [x] Verify interrupted site locks require guarded recovery and stale ETags or competing recovery attempts cannot release a newer lock.
- [ ] Run concurrent `PublishSite` calls for different sites and prove cross-process/provider conditional-write races do not lose updates.
- [x] Inject a `meta.json` upload failure before stale deletion and prove a retry converges.
- [x] Inject a partial stale-artifact deletion and prove a retry converges.
- [x] Verify registry apply retries removed-site cleanup after post-write/delete/invalidation failures using the local test backend.
- [ ] Inject artifact upload and `index.json` replacement failures.
- [x] Exercise the forced `UnregisterSite` cleanup/invalidation retry path directly.
- [x] Complete both site-prefix listings before mutation and abort when either listing fails.
- [x] Exercise AWS pagination, continuation-token errors, malformed listing responses, continuation-page API failure, 1,000-key delete batches, and per-object delete failures.
- [x] Verify exact site-prefix isolation, unchanged registry/app/control/other-site objects, `.git` omission, symlink/special-file rejection, source bytes and paths, and MIME/disposition/encoding/cache metadata.
- [ ] Run real AWS S3 and Cloudflare R2 conditional-write/recovery smoke tests; verify provider cache and invalidation behavior.

## Evidence

The local publisher tests cover both publish/unregister orderings in `internal/publisher/site_publish_test.go` (`TestPublishFirstThenUnregisterWithdrawsAndCleansSite`, `TestUnregisterFirstBlocksPublishBeforeContentWrites`). `internal/publisher/locks_test.go` covers independent per-site lock scopes and guarded recovery (`TestSiteLocksAllowIndependentSitesConcurrently`, `TestInterruptedSiteLockWaitsUntilGuardedRecovery`, `TestSiteLockRecoveryRejectsChangedETagAndRecoveryRace`).

`internal/publisher/site_reconcile_test.go` verifies artifact bytes and paths, metadata ordering, both prefix listings before writes, exact-prefix boundaries, source entry rejection, metadata repair, retry after a metadata upload failure, and retry after partial stale deletion. Artifact upload and `index.json` replacement failure cases remain to be added. Its invalid-UTF-8 filesystem integration case is skipped on Darwin because the filesystem rejects such a filename; the shared validator is unit-tested in `internal/indexer/build_test.go`.

`internal/publisher/aws_reconcile_adapter_test.go` covers multi-page S3 listing, malformed and incomplete responses, deletion batches, per-object failures, and HTTP/cache metadata forwarding. `internal/publisher/aws_reconcile_failure_test.go` verifies that an API failure on the continuation page aborts `PublishSite` before content writes or stale deletion. The shared registry-apply retry test covers removed-site cleanup after post-write failures, but does not directly exercise the forced `UnregisterSite` command path.

`TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent` directly exercises forced `UnregisterSite` listing, partial-delete, and invalidation failures followed by retry, and verifies preview cleanup plus registry, neighboring-site, app, control, and lock preservation. These local and fake-provider checks do not prove live provider conditional writes, cross-process recovery, delivery headers, CDN freshness, or invalidation. Keep T14 open until those remaining gates are verified.

## Implementation links

[IMP-22 site locks](../implementation/IMP-22-site-locks.md), [IMP-23 registry apply](../implementation/IMP-23-registry-apply.md), [IMP-24 publisher eligibility](../implementation/IMP-24-publisher-eligibility.md), [IMP-25 production reconciliation](../implementation/IMP-25-production-reconciler.md), and [IMP-27 admin unregister](../implementation/IMP-27-admin-unregister.md) provide the implementation paths whose broader race and provider evidence is tracked here.
