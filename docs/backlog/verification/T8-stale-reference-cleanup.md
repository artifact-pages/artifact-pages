# T8 — Stale-reference cleanup

- Status: In progress
- Phase: Phase 1 local proof; provider-origin proof remains open

## Contract to prove

Pre-publish and production publish prune catalog references only when their revision manifests are confirmed absent at the selected backend; remote-provider checks must read provider origin. Merge, close, and manual publication do not by themselves remove a live preview.

## Exit criteria

- [x] Show that live open, merged, and closed-unmerged PR fixture groups and a manual preview remain discoverable while their manifests exist. PR lifecycle is not stored or queried by the reconciliation path.
- [x] Show that a missing manifest is hidden by the reader before cleanup and removed on the next catalog write.
- [x] Show that a provider read error is not interpreted as a missing manifest.
- [x] Verify the local CLI calls the shared reconciliation operation and a failed production switch leaves catalog entries unchanged.
- [x] Verify a successful production switch followed by catalog-write failure reports incomplete cleanup and converges on retry; no separate cleanup workflow or PR-state query is required.
- [x] After [IMP-34](../implementation/IMP-34-actions.md) adds a CI wrapper, verify it calls the same operation and produces the same result as the local CLI.
- [ ] Verify cleanup against the configured AWS/Cloudflare provider origin and its deployed failure behavior.

## Evidence

The local reader hides a catalog candidate when its manifest is confirmed missing and keeps a candidate visible with an unknown-availability message after a 503. `internal/preview/store_test.go` covers unavailable-manifest retention, idempotence, and site isolation. `internal/publisher/site_publish_preview_test.go` verifies production-before-catalog ordering, lifecycle-agnostic retention of live PR/manual groups, catalog stability after production-write failure, and retry convergence after catalog-write failure. `cmd/artifact-pages/main_test.go` exercises the local CLI process and JSON for a provider registry-read failure. The Actions parity smoke starts direct CLI and shared Action site-publish calls from equivalent local projections containing a catalog entry with a confirmed-missing manifest; both return the same JSON and exit status with `remove`/`manifest-missing`, and both prune the reference. `node scripts/test-actions-parity.mjs` passes. Actual AWS/Cloudflare origin behavior remains open. The local preview development command writes to `.local/previews`; normal registered-site publishing uses the configured target (for example `.local/storage`) and reconciles that target's `_previews` prefix. See the [catalog cleanup contract](../../architecture/preview-publishing-contract.html#publish).

## Implementation links

[IMP-05 publication](../implementation/IMP-05-publication.md), [IMP-06 production reconciliation](../implementation/IMP-06-production-reconciliation.md), [IMP-09 discovery](../implementation/IMP-09-discovery.md), [IMP-12 storage adapter](../implementation/IMP-12-provider-boundary.md), [IMP-15 retention](../implementation/IMP-15-provider-retention.md), [IMP-13 preview Action](../implementation/IMP-13-action.md), and [IMP-34 site Action](../implementation/IMP-34-actions.md) provide the producer, cleanup, reader and CI/local paths to verify.
