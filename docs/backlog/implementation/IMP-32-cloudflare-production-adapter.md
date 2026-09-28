# IMP-32 — Cloudflare production provider adapter

- Status: Done
- Phase: Provider-backed deployment
- Depends on: settled R2 storage, conditional-write, and purge mappings in [T12](../technical-design/T12-cloudflare-production-mapping.md); [IMP-22](IMP-22-site-locks.md); [IMP-25](IMP-25-production-reconciler.md). Viewer access, if desired, is customer-managed outside the product contract.
- Proves: local provider contract and opt-in live smoke harness; live results belong to [T14](../verification/T14-production-reconciliation.md) and [T15](../verification/T15-provider-delivery.md)

## Outcome

Publish the same registered site projection on the Cloudflare services selected by T12.

## Acceptance criteria

- Registry origin read, complete prefix listing, content sync, conditional per-site lock and unregister cache behavior satisfy the shared contracts.
- Adapter tests include pagination, partial failure/retry, metadata, and conditional-write races; an opt-in live R2 smoke harness covers provider-specific conditional writes. Actual-account results remain in T14/T15; differences from AWS stay at the adapter edge.
- Coordinate shared preview storage with [IMP-18](IMP-18-cloudflare-preview-adapter.md) without treating preview-only proof as production proof.

## Local evidence

`EDGE_PROFILE_STATE_ROOT=.local/edge-profiles-imp32-cloudflare-20260928 EDGE_PORT=8289 MINIO_PORT=19125 CF_API_PORT=18875 node scripts/run-edge-profile.mjs cloudflare` passed against a fresh MinIO S3 origin and Cloudflare purge mock. The runner removed `CF_API_TOKEN` for the SRE and frontend `site publish` calls, proving that this operation uses only R2 credentials. Registry publication and app deployment exercised cache invalidation; the app test verified metadata and Cache-Control for `index.html` and a hashed asset while preserving registry/site/preview objects. `TestLocalEdgeConformance` passed, including the simultaneous conditional `If-Match` writer race, pagination, and storage reconciliation. The unregister flow removed 28 SRE objects, preserved the frontend probe, returned edge 404s for removed SRE paths, and recorded the exact file and prefix purge set. The browser suite passed 55/55. The profile includes `TestCloudflareAppDeployConformance`; Terraform/Cloudflare delivery isn't applied by this local run.

The focused race-enabled Cloudflare adapter tests passed with `go test -race -count=1 ./internal/config ./internal/publisher ./cmd/artifact-pages -run 'TestCloudflare|TestNewCloudflareBackend|TestMapS3ConditionError|TestAWSHeadObject|TestAWSReconcile|TestCloudflareAppDeployConformance'`; the complete config package passed with `go test -race -count=1 ./internal/config`. The live account variables `CF_R2_ACCESS_KEY_ID`, `CF_R2_SECRET_ACCESS_KEY`, and `CF_API_TOKEN` are absent. This local evidence does not establish Cloudflare R2 conditional-write behavior, custom-domain routing, edge cache headers, or live purge propagation. Any customer-managed viewer-access gate is outside this adapter's product contract.

This is local adapter/profile evidence only. It does not prove Cloudflare R2 conditional-write races, real zone purge behavior, or CDN freshness; those stay in T14/T15.

`internal/publisher/cloudflare_preview_live_smoke_test.go` provides a guarded R2 conditional-write smoke against a random, unadvertised preview object beneath a selected registered site's `_previews` prefix. It verifies origin metadata/read/list behavior, create-once and compare-and-swap preconditions, and that only one of two writers using the same ETag succeeds; cleanup is restricted to its generated temporary prefix. The exact opt-in variables and confirmation string are documented in [IMP-18](IMP-18-cloudflare-preview-adapter.md). The smoke does not request a zone purge and has not been run here; live production purge and delivery checks remain in [T15](../verification/T15-provider-delivery.md).

`cloudflare_test.go` also verifies that purge failures preserve provider error codes/messages for both HTTP-level rate limits and HTTP 200 responses with `success:false`, including the zone endpoint context. `go test -race -count=1 ./internal/publisher -run '^TestCloudflareInvalidate'` passed. Live zone purge propagation remains unverified.
