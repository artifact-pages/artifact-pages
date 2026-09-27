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

Not yet run. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).
