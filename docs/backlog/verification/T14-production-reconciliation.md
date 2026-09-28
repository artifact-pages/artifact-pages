# T14 — Production reconciliation and race safety

- Status: In progress
- Phase: Provider-backed deployment

## Proof needed

- [x] Test both normal site publish/unregister lock orderings with a deterministic local backend.
- [x] Verify separate site IDs can hold their own locks concurrently; this proves lock isolation, not concurrent `PublishSite` calls.
- [x] Verify interrupted site locks require guarded recovery and stale ETags or competing recovery attempts cannot release a newer lock.
- [ ] Run concurrent `PublishSite` calls for different sites and prove cross-process/provider conditional-write races do not lose updates.
- [x] Inject a `meta.json` upload failure before stale deletion and prove a retry converges.
- [x] Inject a partial stale-artifact deletion and prove a retry converges.
- [ ] Verify registry publish retries removed-site cleanup after post-write/delete/invalidation failures, including the complete catalog invalidation set on an already-converged origin ([ISSUE-020](../issues/ISSUE-020-unregister-invalidation-retry.md)). Earlier local tests omitted this retry-path gap.
- [x] Inject artifact upload and `index.json` replacement failures.
- [x] Exercise the forced `UnregisterSite` cleanup/invalidation retry path directly.
- [x] Complete both site-prefix listings before mutation and abort when either listing fails.
- [x] Exercise AWS pagination, continuation-token errors, malformed listing responses, continuation-page API failure, 1,000-key delete batches, and per-object delete failures.
- [x] Verify exact site-prefix isolation, unchanged registry/app/control/other-site objects, `.git` omission, symlink/special-file rejection, source bytes and paths, and MIME/disposition/encoding/cache metadata.
- [x] Reject equal local source/target roots and either containment direction before lock creation; also cover symlinked target parents and ignored generated files when the target is separate (completed ISSUE-014).
- [ ] Run real AWS S3 and Cloudflare R2 conditional-write/recovery smoke tests; verify provider cache and invalidation behavior.
- [ ] Cover zero-document desired-state convergence ([ISSUE-018](../issues/ISSUE-018-empty-site-reconciliation.md)).

## Evidence

The local publisher tests cover both publish/unregister orderings in `internal/publisher/site_publish_test.go` (`TestPublishFirstThenUnregisterWithdrawsAndCleansSite`, `TestUnregisterFirstBlocksPublishBeforeContentWrites`). `internal/publisher/locks_test.go` covers independent per-site lock scopes and guarded recovery (`TestSiteLocksAllowIndependentSitesConcurrently`, `TestInterruptedSiteLockWaitsUntilGuardedRecovery`, `TestSiteLockRecoveryRejectsChangedETagAndRecoveryRace`).

`internal/publisher/site_publish_preview_test.go` also verifies that normal `PublishSite` carries its acquired site-lock snapshot through preview-catalog reconciliation. `TestPublishSiteRejectsPreviewReconciliationAfterLockRecovery` recovers and reacquires the lock after production objects are committed but before catalog cleanup; the old publisher detects the changed ETag and leaves the original catalog untouched. `internal/publisher/preview_adapter_test.go` verifies that direct catalog replacement without a lock-bearing context is rejected. These are deterministic local checks, not provider race proof.

The local source/output boundary gate was completed as ISSUE-014. `TestPublishSiteRejectsOverlappingLocalSourceAndTargetBeforeLock` verifies source containment, target containment, equality, the registry-default source path, dry-run behavior, no lock creation, and preservation of prior SRE, neighboring-site, registry, and private-control objects. `TestRejectOverlappingLocalSourceResolvesSymlinkedTargetParent` verifies canonicalized paths, and `TestPublishSiteIncludesIgnoredRegularFilesWhenLocalTargetIsSeparate` confirms ignored generated HTML and binary resources remain publishable. `go test -race ./internal/publisher -run 'TestPublishSite(RejectsOverlappingLocalSourceAndTargetBeforeLock|IncludesIgnoredRegularFilesWhenLocalTargetIsSeparate)$|TestRejectOverlappingLocalSourceResolvesSymlinkedTargetParent$' -count=1` and `go test -race ./...` passed.

`internal/publisher/site_reconcile_test.go` verifies artifact bytes and paths, metadata ordering, both prefix listings before writes, exact-prefix boundaries, source entry rejection, metadata repair, retry after a metadata upload failure, and retry after partial stale deletion. `TestPublishSiteRetriesAfterArtifactAndIndexUploadFailures` injects an artifact replacement failure and an existing `index.json` replacement failure; each failed attempt preserves stale content and the previous failed object, then a retry publishes the replacement and removes stale content last. The focused verification command `go test ./internal/publisher -run '^TestPublishSiteRetriesAfterArtifactAndIndexUploadFailures$' -count=1` passed. Its invalid-UTF-8 filesystem integration case is skipped on Darwin because the filesystem rejects such a filename; the shared validator is unit-tested in `internal/indexer/build_test.go`.

`internal/publisher/aws_reconcile_adapter_test.go` covers multi-page S3 listing, malformed and incomplete responses, deletion batches, per-object failures, and HTTP/cache metadata forwarding. `internal/publisher/aws_reconcile_failure_test.go` verifies that an API failure on the continuation page aborts `PublishSite` before content writes or stale deletion. The shared registry-apply retry test covers removed-site cleanup after post-write failures, but does not directly exercise the forced `UnregisterSite` command path.

`internal/publisher/s3_compatible_head_test.go` verifies that ambiguous S3-compatible `HeadObject` 404s are confirmed through a complete exact-key listing: `NoSuchKey` is preserved, `NoSuchBucket` skips listing, longer prefix neighbors count as absence, an exact listed key preserves the original HEAD error, and list failures preserve that same error. `go test ./internal/publisher -run '^TestS3CompatibleHeadObjectConfirmsAmbiguous404ByExactKey$' -count=1` and `go test -race ./...` passed. This shared adapter evidence covers AWS, Cloudflare/R2, and MinIO implementations locally; it does not replace live-provider race evidence.

`internal/publisher/aws_invalidation_test.go` verifies the CloudFront invalidation request fields, returned ID, and wrapped API failures through a fake client. `go test ./internal/publisher -run '^TestAWSInvalidate' -count=1` passed. This adapter test does not prove live invalidation or CDN freshness.

`TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent` directly exercises forced `UnregisterSite` listing, partial-delete, and invalidation failures followed by retry, and verifies preview cleanup plus registry, neighboring-site, app, control, and lock preservation. These local and fake-provider checks do not prove live provider conditional writes, cross-process recovery, delivery headers, CDN freshness, or invalidation. Keep T14 open until those remaining gates are verified.

The fresh Cloudflare MinIO + purge-mock profile (`EDGE_PROFILE_STATE_ROOT=.local/edge-profiles-cloudflare-head-fallback EDGE_PORT=8195 MINIO_PORT=19025 CF_API_PORT=18805 node scripts/run-edge-profile.mjs cloudflare`) published new SRE and frontend artifacts, unregistered SRE, verified that all 28 SRE artifact/index/preview objects were removed while the frontend probe and index remained, and checked the mock's exact unregister purge paths. `TestLocalEdgeConformance` and E2E passed (55/55); the profile was stopped with the matching `down cloudflare` command. This strengthens local provider-adapter evidence only; it does not close the real AWS S3/R2 race and invalidation gate above.

## Implementation links

[IMP-22 site locks](../implementation/IMP-22-site-locks.md), [IMP-23 registry publish](../implementation/IMP-23-registry-apply.md), [IMP-24 publisher eligibility](../implementation/IMP-24-publisher-eligibility.md), [IMP-25 production reconciliation](../implementation/IMP-25-production-reconciler.md), [IMP-27 registry unregister](../implementation/IMP-27-admin-unregister.md), and [IMP-29 AWS adapter](../implementation/IMP-29-aws-production-adapter.md) provide the implementation paths whose broader race and provider evidence is tracked here.
