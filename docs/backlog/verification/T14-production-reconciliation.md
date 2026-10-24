# T14 — Production reconciliation and race safety

- Status: In progress
- Assignee: Codex
- Phase: Provider-backed deployment

## Proof needed

- [x] Test both normal site publish/unregister lock orderings with a deterministic local backend.
- [x] Verify separate site IDs can hold their own locks concurrently; this proves lock isolation, not concurrent `PublishSite` calls.
- [x] Verify interrupted site locks require guarded recovery and stale ETags or competing recovery attempts cannot release a newer lock.
- [ ] Run concurrent production `PublishSite` calls for different sites across processes/providers and prove updates survive. Independent lock scopes and same-site preview races already have evidence; neither substitutes for this production case.
- [x] Inject a `meta.json` upload failure before stale deletion and prove a retry converges.
- [x] Inject a partial stale-artifact deletion and prove a retry converges.
- [x] Verify unregister retries removed-site cleanup after listing/delete/invalidation failures, including the complete catalog/site/preview invalidation set on an already-converged origin (ISSUE-020 local fake-backend evidence below).
- [x] Inject artifact upload and `index.json` replacement failures.
- [x] Exercise the forced `UnregisterSite` cleanup/invalidation retry path directly.
- [x] Complete both site-prefix listings before mutation and abort when either listing fails.
- [x] Exercise AWS pagination, continuation-token errors, malformed listing responses, continuation-page API failure, 1,000-key delete batches, and per-object delete failures.
- [x] Verify exact site-prefix isolation, unchanged registry/app/control/other-site objects, `.git` omission, symlink/special-file rejection, source bytes and paths, and MIME/disposition/encoding/cache metadata.
- [x] Reject equal local source/target roots and either containment direction before lock creation; also cover symlinked target parents and ignored generated files when the target is separate (completed ISSUE-014).
- [x] Record real R2 conditional-write and named preview recovery smoke evidence (T15 and October 2 recovery record).
- [ ] Run remaining live AWS conditional-write/recovery and production-publish recovery cases; finish provider cache/invalidation coverage beyond the existing samples.
- [x] Cover zero-document desired-state convergence (completed ISSUE-018): publish `artifacts: []` with `artifactCount: 0`, retain source resources and live previews, preserve registry/app/control/neighbor boundaries, and retry after partial stale deletion.

## Evidence

The local publisher tests cover both publish/unregister orderings in `internal/publisher/site_publish_test.go` (`TestPublishFirstThenUnregisterWithdrawsAndCleansSite`, `TestUnregisterFirstBlocksPublishBeforeContentWrites`). `internal/publisher/locks_test.go` covers independent per-site lock scopes and guarded recovery (`TestSiteLocksAllowIndependentSitesConcurrently`, `TestInterruptedSiteLockWaitsUntilGuardedRecovery`, `TestSiteLockRecoveryRejectsChangedETagAndRecoveryRace`).

`internal/publisher/site_publish_preview_test.go` also verifies that normal `PublishSite` carries its acquired site-lock snapshot through preview-catalog reconciliation. `TestPublishSiteRejectsPreviewReconciliationAfterLockRecovery` recovers and reacquires the lock after production objects are committed but before catalog cleanup; the old publisher detects the changed ETag and leaves the original catalog untouched. `internal/publisher/preview_adapter_test.go` verifies that direct catalog replacement without a lock-bearing context is rejected. These are deterministic local checks, not provider race proof.

The local source/output boundary gate was completed as ISSUE-014. `TestPublishSiteRejectsOverlappingLocalSourceAndTargetBeforeLock` verifies source containment, target containment, equality, the registry-default source path, dry-run behavior, no lock creation, and preservation of prior SRE, neighboring-site, registry, and private-control objects. `TestRejectOverlappingLocalSourceResolvesSymlinkedTargetParent` verifies canonicalized paths, and `TestPublishSiteIncludesIgnoredRegularFilesWhenLocalTargetIsSeparate` confirms ignored generated HTML and binary resources remain publishable. `go test -race ./internal/publisher -run 'TestPublishSite(RejectsOverlappingLocalSourceAndTargetBeforeLock|IncludesIgnoredRegularFilesWhenLocalTargetIsSeparate)$|TestRejectOverlappingLocalSourceResolvesSymlinkedTargetParent$' -count=1` and `go test -race ./...` passed.

`internal/publisher/site_reconcile_test.go` verifies artifact bytes and paths, metadata ordering, both prefix listings before writes, exact-prefix boundaries, source entry rejection, metadata repair, retry after a metadata upload failure, and retry after partial stale deletion. `TestPublishSiteRetriesAfterArtifactAndIndexUploadFailures` injects an artifact replacement failure and an existing `index.json` replacement failure; each failed attempt preserves stale content and the previous failed object, then a retry publishes the replacement and removes stale content last. The focused verification command `go test ./internal/publisher -run '^TestPublishSiteRetriesAfterArtifactAndIndexUploadFailures$' -count=1` passed. Its invalid-UTF-8 filesystem integration case is skipped on Darwin because the filesystem rejects such a filename; the shared validator is unit-tested in `internal/indexer/build_test.go`.

`internal/publisher/aws_reconcile_adapter_test.go` covers multi-page S3 listing, malformed and incomplete responses, deletion batches, per-object failures, and HTTP/cache metadata forwarding. `internal/publisher/aws_reconcile_failure_test.go` verifies that an API failure on the continuation page aborts `PublishSite` before content writes or stale deletion. The shared registry-apply retry test covers removed-site cleanup after post-write failures, and the later `TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent` below directly exercises forced `UnregisterSite` cleanup.

`internal/publisher/s3_compatible_head_test.go` verifies that ambiguous S3-compatible `HeadObject` 404s are confirmed through a complete exact-key listing: `NoSuchKey` is preserved, `NoSuchBucket` skips listing, longer prefix neighbors count as absence, an exact listed key preserves the original HEAD error, and list failures preserve that same error. `go test ./internal/publisher -run '^TestS3CompatibleHeadObjectConfirmsAmbiguous404ByExactKey$' -count=1` and `go test -race ./...` passed. This shared adapter evidence covers AWS, Cloudflare/R2, and MinIO implementations locally; it does not replace live-provider race evidence.

`internal/publisher/aws_invalidation_test.go` verifies the CloudFront invalidation request fields, returned ID, and wrapped API failures through a fake client. `go test ./internal/publisher -run '^TestAWSInvalidate' -count=1` passed. This adapter test does not prove live invalidation or CDN freshness.

`TestUnregisterSiteRetriesRemovedSiteCleanupAfterPostWriteFailures` exercises cleanup by unregistering a registered site after listing, partial-delete, and invalidation failures. Each retry dry-run reports the exact six catalog/site/preview paths without changing objects, ETags, cache requests, or the retry record; the real retry requests the same paths and preserves registered neighbors, the app plane, and unrelated control data. `TestRegisterSitesRetainsPendingCatalogInvalidationWhenCleanupTargetIsRegistered` verifies a remaining retry record still requests catalog invalidation and is cleared only after the request succeeds. `TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent` also covers forced cleanup retries. These local and fake-provider checks do not prove live provider conditional writes, cross-process recovery, delivery headers, CDN freshness, or invalidation. Keep T14 open until those remaining gates are verified.

The fresh Cloudflare MinIO + purge-mock profile (`EDGE_PROFILE_STATE_ROOT=.local/edge-profiles-cloudflare-head-fallback EDGE_PORT=8195 MINIO_PORT=19025 CF_API_PORT=18805 node scripts/run-edge-profile.mjs cloudflare`) published new SRE and frontend artifacts, unregistered SRE, verified that all 28 SRE artifact/index/preview objects were removed while the frontend probe and index remained, and checked the mock's exact unregister purge paths. `TestLocalEdgeConformance` and E2E passed (55/55); the profile was stopped with the matching `down cloudflare` command. This strengthens local provider-adapter evidence only; it does not close the real AWS S3/R2 race and invalidation gate above.

`internal/indexer/build_test.go` verifies a resource-only source produces `artifacts: []` and `artifactCount: 0`. `internal/publisher/site_empty_publish_test.go` publishes two documents, removes both, injects a partial stale deletion, and verifies retry leaves only the CSS resource and zero-document index/meta. The same test confirms the registry, application plane, private control object, neighboring site, and a live preview remain intact. `e2e/local-serving.spec.ts` verifies the empty registered site home, explicit `index.html` not-found route, and unaffected neighbor navigation.

The ISSUE-018 verification run passed `go test -race -count=1 ./internal/publisher ./internal/indexer` and `npm run test:e2e` (production build plus 60 Playwright tests through local nginx).

## Implementation links

[IMP-22 site locks](../implementation/IMP-22-site-locks.md), [IMP-23 registry registration](../implementation/IMP-23-registry-apply.md), [IMP-24 publisher eligibility](../implementation/IMP-24-publisher-eligibility.md), [IMP-25 production reconciliation](../implementation/IMP-25-production-reconciler.md), [IMP-27 registry unregister](../implementation/IMP-27-admin-unregister.md), and [IMP-29 AWS adapter](../implementation/IMP-29-aws-production-adapter.md) provide the implementation paths whose broader race and provider evidence is tracked here.

## Reconciliation — 2026-10-18

[T5](T5-concurrency-recovery.md) / [Cloudflare recovery proof](../cloudflare-preview-recovery-proof.md) credit real R2 CAS, preview new-head races, partial-upload recovery and stale-owner rejection. [T15](T15-provider-delivery.md) credits Cloudflare warm withdrawal and AWS update/unregister samples. Earlier blanket absence claims do not apply to those completed samples. None proves concurrent actual production `PublishSite` across different sites/processes, all production interruption points, or reference-role CDN retry/freshness. Those remain open with AWS recovery and are one coordinated owner-gated plan, not separate duplicate experiments.

## Coordinated execution plan

The [October 18 provider-proof plan](provider-proof-plan-2026-10-18.md) owns the remaining shared execution matrix (P4–P7), pinned inputs, commands, preservation/cleanup guards and itemized owner approvals. The [October 20 superseding decision](provider-proof-plan-2026-10-18.md#superseding-execution-decision--october-20-2026) makes Claude main the direct executor with reviewed commands and chat OK under the existing A4–A9 scopes; the harness/signature/registry gates are retired. Hosted OIDC evidence remains required for reference-role claims. Unsupported P4–P7 fault cells stay open/not-run; no criteria close without actual evidence. Recurring supported P4–P7 coverage is planned in [T28](T28-provider-release-regression.md), separately from the one-off fresh-bucket/bootstrap, natural-expiry timing and migration proofs. This edit records no new provider result.

## Cloudflare A6/A7 recorded evidence — October 24–25, 2026

**Cloudflare local scoped-credential evidence (CLI 0.4.4 darwin_arm64); not hosted Actions/OIDC.** Source: `~/.config/artifact-pages-verify/a6-20261024/evidence/` (`A6-NOTES.md`, `NOTES-A6-part1.md`, `A7-NOTES.md`, `RESTORE-NOTES.md`, `pre/NOTES.md`, `restore/expected-deltas.md`); runbook D1–D11. See the [shared per-cell execution record](provider-proof-plan-2026-10-18.md#cloudflare-a6a7-execution-result--october-2425-2026) and [restoration record](provider-proof-plan-2026-10-18.md#cloudflare-restoration--october-2425-2026). This scoped local run did not exercise Actions v0.2.0 on Cloudflare.

P5-artifact AccessDenied preserved index/meta/stale canary; both initial prefix-list denials happened before mutation with unchanged projection. Normal recovery converged, second retries no-op. P5-index/meta PUT faults were NOT-RUN: v0.4.4 GETs them for generatedAt preservation, preventing R2 GET/PUT isolation. P6 missing/403/intact classification passed with unknown retention, but write exit 0 does not prove unavailable-cleanup failure semantics. Production failure before switch, production a/b overlap, partial deletion/continuation/lock-loss barriers and post-switch catalog faults remain NOT-RUN. P4 credits the October 2 samples only.

P7-site/registry/app real purge-only authorization failures (HTTP 401 code 10000, token without Cache Purge) retained retry records and identical authorized retries cleared them; warm site-update and unregister first polls were fresh. Broader reference-identity/freshness and unregister-failure criteria stay open. App restored to 0.3.2, proof sites unregistered and 90 exact residue keys deleted; FINAL 109-key A4 comparison differs only by registry last-writer CLI version, with metadata preserved. P7 proves CLI 0.4.4 only; PR #206 / IMP-82 / T30 remove invalidation. Keep aggregate proof open.
