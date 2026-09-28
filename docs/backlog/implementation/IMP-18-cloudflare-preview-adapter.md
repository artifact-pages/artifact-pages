# IMP-18 — Cloudflare preview storage adapter

- Status: Done
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-05](IMP-05-publication.md), and the Cloudflare service mapping in [T9](../technical-design/T9-cloudflare-store-mapping.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Map the provider-neutral `PreviewStore` contract to the selected Cloudflare storage and locking services. Preserve the same object keys, v1 records, immutable revision rules, catalog update order, and browser routes used by the directory and AWS adapters.

## Acceptance criteria

- Adapter operations distinguish confirmed object absence from authorization, transport, and partial-listing failures.
- Immutable objects use the provider's safe create-once behavior; mutable catalog replacement and per-site locking preserve concurrent group updates.
- Cloudflare credentials, object routing, and lock mechanics remain in the adapter/deployment boundary; preview-group or expiry decisions stay in the shared core.
- Deterministic provider-fake checks cover idempotent retry, concurrent groups, lock loss, and interrupted writes without crossing site prefixes. Opt-in R2 smoke harnesses are supplied for conditional create/compare-and-swap/races and the shared preview publication flow, including same-head retry and multiple catalog groups.
- Actual R2 behavior and Cloudflare serving, cache, access, lifecycle, and cleanup evidence remain in [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md), [T14](../verification/T14-production-reconciliation.md), and [T15](../verification/T15-provider-delivery.md); a live run is not required to close this source-and-harness implementation ticket.

## Local evidence

`cloudflare_preview_integration_test.go` composes `NewCloudflareBackend` with `ObjectPreviewStore` through a signed, local S3-compatible HTTP endpoint. `TestCloudflarePreviewIntegrationRetriesInterruptedWriteIdempotentlyAndIsolatesSites` injects a manifest-write failure and verifies retry/idempotence without changing the neighboring site's prefix or lock. `TestCloudflarePreviewIntegrationConcurrentGroupsKeepCatalogAndIsolateSites` holds the first publisher inside an immutable-object PUT, confirms the second observes the held site lock without completing or writing objects, then releases the first and verifies both groups survive. `TestCloudflarePreviewIntegrationLockLossPreventsCatalogWriteAndPreservesOtherSite` replaces the held site lock before catalog update and verifies that the stale publisher does not advertise the revision. `go test -race -count=1 -run '^TestCloudflarePreviewIntegration' ./internal/publisher` passes. These tests verify Cloudflare adapter request composition against a local fake only.

`internal/publisher/cloudflare_preview_live_smoke_test.go` adds an opt-in live R2 smoke for `If-None-Match`, stale and current `If-Match`, a competing writer race, origin reads, metadata, and listing. Run it with `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_RUN=1`, `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_ACCOUNT_ID`, `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_BUCKET`, `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_ZONE_ID`, `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_PUBLIC_BASE_URL`, `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_SITE`, `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, optional `CF_R2_SESSION_TOKEN`, and `ARTIFACT_PAGES_CLOUDFLARE_SMOKE_CONFIRM="WRITE AND DELETE TEMPORARY OBJECTS IN <bucket> UNDER SITE <site>"`. `internal/publisher/preview_flow_live_smoke_test.go` adds an opt-in live R2 preview-publication smoke for create-once behavior, same-head idempotence, multiple catalog groups, and generated-namespace cleanup. Run it with `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_RUN=1`, `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_ACCOUNT_ID`, `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_DISPOSABLE_BUCKET`, `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_ZONE_ID`, `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_PUBLIC_BASE_URL`, `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_DISPOSABLE_SITE`, the same R2 credentials, and `ARTIFACT_PAGES_CLOUDFLARE_PREVIEW_FLOW_SMOKE_CONFIRM="WRITE AND DELETE RANDOM PREVIEW DATA IN DISPOSABLE R2 BUCKET <bucket> FOR REGISTERED SMOKE SITE <site>"`. Both require the selected site to exist in the deployed registry and remove only their isolated random prefix. Neither smoke was run because no target or credentials were provided. Live results remain unverified separately in [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md), [T14](../verification/T14-production-reconciliation.md), and [T15](../verification/T15-provider-delivery.md).

## Source review note

The shared S3-compatible adapter now maps only the `NoSuchKey` API response to confirmed absence. `NoSuchBucket` and unclassified 404s remain errors; AWS `HeadObject` ambiguity is checked against an exact-key origin listing. Focused tests exercise the shared error contract. Cloudflare fake evidence is complete; live R2 race, serving, cache, and retention evidence remains open in [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md), [T14](../verification/T14-production-reconciliation.md), and [T15](../verification/T15-provider-delivery.md).
