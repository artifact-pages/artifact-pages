# T5 — Concurrency and recovery

- Status: In progress
- Phase: Phase 1 local proof; cross-process/provider recovery remains post-MVP

## Contract to prove

The shared site lock and retry-safe catalog replacement preserve the Phase 1 publication boundary and keep discovery consistent through local concurrent publishes, retries, and interrupted uploads. Provider conditional catalog writes and cross-process lock recovery remain adapter verification gates.

## Exit criteria

- [x] Run two concurrent preview group updates on one site against the local `PreviewStore`.
- [ ] Run both actual preview-publish/unregister orderings after the registered-site preview publication path is introduced ([IMP-16](../implementation/IMP-16-unregister.md), Post-MVP).
- [x] Run both normal site publish/admin unregister orderings against a deterministic local backend.
- [x] Inject failure after bundle upload, after manifest completion, and before catalog update; retry without advertising an incomplete revision.
- [x] Reject a same-head retry that changes selected documents or bytes.
- [ ] Exercise stale-lock recovery and conditional-write races without losing an unrelated group's update.

## Evidence

The local writer verifies an existing immutable manifest and each stored file's bytes on same-head retry, rejects changed bytes or selected documents, writes the manifest only after its files, and updates discovery afterward. `internal/preview/store_test.go` deterministically overlaps two group updates and proves both survive; it also covers no-preview removal, missing-versus-unavailable manifest pruning through catalog upsert, and partial bundle, manifest, and catalog failures converging on retry without advertising an incomplete revision. `internal/preview/git_test.go` verifies a resource-only change leaves an existing local catalog unchanged through `BuildAndPublish`. The normal site publisher and admin unregister also have deterministic local tests for both interleavings: publish-first finishes under the site lock before cleanup, while unregister-first withdraws eligibility before cleanup and rejects the waiting publisher without content mutations (`internal/publisher/site_publish_test.go`). Those cases now seed and check site preview objects, but exercise normal site publication rather than the preview writer. `PreviewStore.WithSiteLock` exposes the preview operation boundary. The `DirectoryStore` implementation coordinates only within one process. Actual preview-publisher/unregister orderings, cross-process lock loss, and provider conditional catalog races remain open. Conditional catalog updates belong to the provider adapter contract, not the Phase 1 `PreviewStore`. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).

## Implementation links

[IMP-01 records](../implementation/IMP-01-preview-records.md), [IMP-04 provenance](../implementation/IMP-04-pr-provenance.md), [IMP-05 publication](../implementation/IMP-05-publication.md), [IMP-16 unregister](../implementation/IMP-16-unregister.md), [IMP-11 CLI](../implementation/IMP-11-cli.md), [IMP-12 storage adapter](../implementation/IMP-12-provider-boundary.md), [IMP-24 publisher eligibility](../implementation/IMP-24-publisher-eligibility.md), and [IMP-25 production reconciliation](../implementation/IMP-25-production-reconciler.md) provide the operations and fault points. Keep T5 open until the remaining preview, cross-process, and provider recovery evidence exists.
