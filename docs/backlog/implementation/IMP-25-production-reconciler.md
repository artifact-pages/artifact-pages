# IMP-25 — Reconcile a site's production projection

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-22](IMP-22-site-locks.md), [IMP-24](IMP-24-publisher-eligibility.md)
- Proves: source boundaries, ordering, retry, pagination and metadata behavior; [T5](../verification/T5-concurrency-recovery.md), [T14](../verification/T14-production-reconciliation.md)

## Outcome

Synchronize the selected source tree and generated index/meta into only that site's content prefixes, converging on retry. AWS S3 and R2 share the provider-neutral S3-compatible object adapter; CloudFront and Cloudflare cache invalidation stay in their provider wrappers.

## Acceptance criteria

- Accept only regular files/directories inside `sourcePath`; fail on symlinks or special entries; omit `.git`; preserve bytes and relative names without bundling or rewriting.
- Complete all required prefix listings before deletion; handle continuation pages, bounded delete batches and per-object failures.
- Upload new/changed artifact bytes first, then `index.json`, then `meta.json`, then remove stale artifact objects; never touch the registry, app plane, control objects or other sites.
- Assign browser-correct MIME/disposition/encoding and cache metadata; interrupted runs and partial deletes fail visibly and converge on retry.

## Verification

- `go test -race -count=1 ./internal/publisher ./internal/indexer` — passed.
- Empty source-document sets publish an `artifacts: []` index and zero-count metadata while preserving resources; publisher retry coverage injects partial stale-document deletion and verifies boundary objects and live-preview retention.
- `go test -race -count=1 ./internal/publisher` — passed after adding the `PublishSite` lock-loss regression.
- `go test -race -count=10 ./internal/publisher -run 'Test(PublishFirstThenUnregisterWithdrawsAndCleansSite|UnregisterFirstBlocksPublishBeforeContentWrites)'` — passed.
- `go test -race -count=1 ./internal/publisher -run '^TestS3ConditionalWritesMapSharedLockConditionsForAWSAndR2$'` — passed.
- Reconciliation tests cover source bytes and names, `.git` omission, symlink/special-entry rejection, UTF-8 path validation, metadata repair, required prefix listings, ordered writes/deletes, retry convergence, and scope isolation.
- AWS adapter tests cover pagination and malformed/incomplete responses, continuation-page API failure before mutations, bounded delete batches, per-object errors, and metadata forwarding.
- `TestPublishSiteRejectsPreviewReconciliationAfterLockRecovery` confirms that a site publisher whose lock is recovered and reacquired before catalog pruning cannot rewrite the preview catalog using its stale lock snapshot. Catalog replacement without an active lock context is also rejected.
- Invalid UTF-8 filesystem integration cases skip on Darwin because its filesystem rejects such names; the shared UTF-8 validator is tested directly.
- Live AWS/R2 delivery and conditional-write evidence remains tracked separately in [T14](../verification/T14-production-reconciliation.md) and [T15](../verification/T15-provider-delivery.md).
