# T5 — Concurrency and recovery

- Status: Open
- Phase: Post-MVP preview

## Contract to prove

The shared site lock and conditional catalog write preserve the registered-site boundary and keep discovery consistent through concurrent publishes, unregister, retries, and interrupted uploads.

## Exit criteria

- [ ] Run both pre-publish/unregister orderings and two concurrent group updates on one site.
- [ ] Inject failure after bundle upload, after manifest completion, and before catalog update; retry without advertising an incomplete revision.
- [ ] Reject a same-head retry that changes selected documents or bytes.
- [ ] Exercise stale-lock recovery and conditional-write races without losing an unrelated group's update.

## Evidence

Not run. The current product has no preview publication/catalog-update operation to coordinate or fault-inject. T1's record and storage-key contract is still in progress, with T2 and T3 open, so preview-specific lock ownership, conditional catalog writes, same-head retries, and partial-upload recovery cannot yet be exercised. No preview exit criteria are verified. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).

## Implementation links

[IMP-01 records](../implementation/IMP-01-preview-records.md), [IMP-04 provenance](../implementation/IMP-04-pr-provenance.md), [IMP-05 publication](../implementation/IMP-05-publication.md), [IMP-16 unregister](../implementation/IMP-16-unregister.md), [IMP-11 CLI](../implementation/IMP-11-cli.md), and [IMP-12 storage adapter](../implementation/IMP-12-provider-boundary.md) provide the operations and fault points. Keep T5 open until concurrency and recovery evidence exists.
