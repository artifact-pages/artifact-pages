# IMP-05 — Locked revision publication and catalog updates

- Status: Done
- Phase: Phase 1 local proof; provider lifecycle remains post-MVP
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-02](IMP-02-source-selection.md), [IMP-03](IMP-03-resource-bundle.md), [IMP-04](IMP-04-pr-provenance.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Implement the shared preview projection flow behind `PreviewStore`. The local implementation writes a complete revision, writes its completion manifest last, then upserts the site catalog. Provider-origin registry validation, cross-process lock behavior, and provider cleanup remain outside the local proof.

## Evidence

The common `Publish` flow validates records and digests, takes the store's per-site lock, writes immutable files and the manifest before catalog replacement, preserves same-head objects, prunes only confirmed-missing manifests, and removes only the named group for `no-preview`. `internal/preview/store_test.go` covers overlapping group updates, group-specific head advancement, verified same-head retries, confirmed-missing versus unavailable manifests during both reconciliation and catalog upsert, and retry after file, manifest, and catalog failures. `internal/preview/git_test.go` verifies a resource-only change leaves an existing local catalog untouched through `BuildAndPublish`. The directory adapter's lock is process-local; cross-process lock loss, origin registry revalidation, and provider conditional-write races remain unverified under [T5](../verification/T5-concurrency-recovery.md).

## Acceptance criteria

- Two concurrent groups retain both catalog entries; newer publication in one group changes only its discoverable head. Same-head retry verifies the existing bundle and rejects changed bytes or selected documents.
- `no-preview` removes only the named group's discovery entry; non-document-only error and failed uploads do not advertise a revision.
- Confirmed missing manifests are pruned during catalog write; provider read errors are not treated as absence.
- Local fault-injection tests cover upload, manifest and catalog failures, and retry convergence; no incomplete revision becomes discoverable.
- Provider lock-loss and conditional catalog-write races remain separate [T5](../verification/T5-concurrency-recovery.md) evidence gates under [IMP-12](IMP-12-provider-boundary.md) and [IMP-18](IMP-18-cloudflare-preview-adapter.md); they are required before provider-backed preview publication is called complete.
