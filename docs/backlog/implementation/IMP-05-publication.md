# IMP-05 — Locked revision publication and catalog updates

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-02](IMP-02-source-selection.md), [IMP-03](IMP-03-resource-bundle.md), [IMP-04](IMP-04-pr-provenance.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Implement provider-neutral pre-publish orchestration using the shared per-site lock. Revalidate the deployed registry from provider origin, upload a complete revision, write its completion manifest last, then upsert the site catalog from origin. Keep immutable revision bytes separate from mutable discovery.

## Acceptance criteria

- Two concurrent groups retain both catalog entries; newer publication in one group changes only its discoverable head. Same-head retry verifies the existing bundle and rejects changed bytes or selected documents.
- `no-preview` removes only the named group's discovery entry; non-document-only error and failed uploads do not advertise a revision.
- Confirmed missing manifests are pruned during catalog write; provider read errors are not treated as absence.
- Fault-injection tests cover upload, manifest and catalog failures, retry convergence, lock loss and conditional-write races; no incomplete revision becomes discoverable.
