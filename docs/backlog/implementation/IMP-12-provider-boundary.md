# IMP-12 — AWS preview storage adapter

- Status: Done
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority.
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-05](IMP-05-publication.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Map the provider-neutral preview storage/lock contract to the AWS reference adapter. Keep provider operations behind the shared interface; do not move preview discovery or expiry decisions into a request-time backend.

Cloudflare has a separate adapter ticket so its credentials, storage API, and locking implementation can evolve independently while preserving the same `PreviewStore` behavior and preview records.

## Acceptance criteria

- Deterministic adapter integration tests exercise conditional site locking, origin registry revalidation, multi-page listing, manifest availability and storage failures without crossing site prefixes.
- A same-head retry does not overwrite completed objects or refresh lifecycle age; mutable catalog replacement is guarded by the cooperative site lock and can be retried after failure.
- Provider fakes cover concurrent groups, lock loss and interrupted uploads. An opt-in AWS smoke harness is supplied for the preview publication path and real S3 conditional object-write semantics using an explicitly designated smoke site. Running it against a provider and recording its behavior belongs to [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md), and [T15](../verification/T15-provider-delivery.md). This ticket does not claim serving policy or retention is done; see [IMP-14](IMP-14-provider-serving.md) and [IMP-15](IMP-15-provider-retention.md).

The AWS live preview-flow smoke uses a random prefix matching `_previews/<site>/.artifact-pages-preview-flow-smoke-<random>/` and remaps its catalog and lock into that prefix. Its cleanup enumerates every S3 object version and delete marker, deletes by version ID in bounded batches, and relists until the exact random prefix is empty. To opt in, set `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_RUN=1`, `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_REGION`, `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_BUCKET`, `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE`, and `ARTIFACT_PAGES_AWS_PREVIEW_FLOW_SMOKE_CONFIRM="WRITE AND DELETE RANDOM PREVIEW DATA AND ALL VERSIONS/DELETE MARKERS IN DISPOSABLE S3 BUCKET <bucket> FOR REGISTERED SMOKE SITE <site>"`; use the standard AWS credential chain. The site must already exist in the deployed registry. The role needs `s3:ListBucketVersions` on the designated bucket, with its `s3:prefix` condition limited to `_previews/<site>/.artifact-pages-preview-flow-smoke-*` where supported, and `s3:DeleteObjectVersion` on `_previews/<site>/.artifact-pages-preview-flow-smoke-*/*` only.

## Local evidence

`internal/publisher/aws_preview_integration_test.go` composes `awsBackend` and `ObjectPreviewStore` over a deterministic in-memory S3 API fake. It verifies origin registry revalidation happens after site-lock acquisition and before preview writes, lock and immutable objects use conditional S3 requests, and a failed manifest upload can be retried without changing completed file bytes or ETags or touching a neighboring site's prefix or lock. `TestAWSPreviewIntegrationConcurrentGroupsKeepBothCatalogAndIsolateOtherSites` serializes two groups through the AWS adapter and preserves both catalog entries; `TestAWSPreviewIntegrationRejectsCatalogWriteAfterLockLossWithoutCrossSiteWrites` verifies loss of the held lock stops catalog publication while preserving the neighboring site's objects and lock. `TestUnregisterSiteCleansEveryAWSListingPageWithFakeBackend` and `TestUnregisterSiteRetriesAfterAWSContinuationListingFailure` cover AWS fake pagination and retry-safe preview-prefix cleanup; `TestMapS3ConditionErrorRequiresConfirmedMissingKey` covers confirmed missing-key mapping. `TestAWSPreviewPublicationFlowSmoke` supplies an opt-in live smoke for isolated preview publication, create-once behavior, same-head idempotence, and multiple catalog groups. Its version-aware cleanup lists and deletes all object versions and delete markers beneath only its generated namespace. The focused adapter, smoke-harness, and cleanup tests pass; the live test was skipped without an explicitly designated AWS target and credentials. Live AWS conditional-write, concurrency, lock-loss, interrupted-upload, lifecycle-age, and origin-cleanup behavior remains unverified in [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md), and [T15](../verification/T15-provider-delivery.md).
