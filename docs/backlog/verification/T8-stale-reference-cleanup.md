# T8 — Stale-reference cleanup

- Status: Open
- Phase: Post-MVP preview

## Contract to prove

Pre-publish and production publish prune catalog references only when their revision manifests are confirmed absent at provider origin. Merge, close, and manual publication do not by themselves remove a live preview.

## Exit criteria

- [ ] Show that merged, closed-unmerged, open, and manual previews with live manifests remain discoverable.
- [ ] Show that a missing manifest is hidden by the reader before cleanup and removed on the next catalog write.
- [ ] Show that a provider read error is not interpreted as a missing manifest.
- [ ] Verify local and CI invocations produce the same result, and that a failed production switch leaves catalog entries unchanged.
- [ ] Verify a successful production switch followed by catalog-write failure reports incomplete cleanup for a retry; no separate workflow or PR-state query is required.

## Evidence

Not run. No preview pre-publish or production catalog-cleanup operation is available to test local/CI parity, provider-read-error handling, or retry after a failed catalog write. T1 is still in progress and T2/T3 remain open; do not infer cleanup behavior from PR state or from ordinary artifact reconciliation. See the [catalog cleanup contract](../../architecture/preview-publishing-contract.html#publish).

## Implementation links

[IMP-05 publication](../implementation/IMP-05-publication.md), [IMP-06 production reconciliation](../implementation/IMP-06-production-reconciliation.md), [IMP-09 discovery](../implementation/IMP-09-discovery.md), [IMP-12 storage adapter](../implementation/IMP-12-provider-boundary.md), [IMP-15 retention](../implementation/IMP-15-provider-retention.md), and [IMP-13 Action](../implementation/IMP-13-action.md) provide the producer, cleanup, reader and CI/local paths to verify.
