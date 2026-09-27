# IMP-12 — AWS preview storage adapter

- Status: Open
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority.
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-05](IMP-05-publication.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Map the provider-neutral preview storage/lock contract to the AWS reference adapter. Keep provider operations behind the shared interface; do not move preview discovery or expiry decisions into a request-time backend.

Cloudflare has a separate adapter ticket so its credentials, storage API, and locking implementation can evolve independently while preserving the same `PreviewStore` behavior and preview records.

## Acceptance criteria

- Adapter integration exercises conditional site locking, origin registry revalidation, multi-page listing, manifest availability and storage failures without crossing site prefixes.
- A same-head retry does not overwrite completed objects or refresh lifecycle age; catalog updates are conditional and can be retried after failure.
- Provider fake and narrow real-provider smoke tests cover concurrent groups, lock loss and interrupted uploads. This ticket does not claim serving policy or retention is done; see [IMP-14](IMP-14-provider-serving.md) and [IMP-15](IMP-15-provider-retention.md).
