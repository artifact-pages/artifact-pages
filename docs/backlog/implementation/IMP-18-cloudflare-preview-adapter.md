# IMP-18 — Cloudflare preview storage adapter

- Status: In progress
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-05](IMP-05-publication.md), and the Cloudflare service mapping in [T9](../technical-design/T9-cloudflare-store-mapping.md)
- Proves: [T5](../verification/T5-concurrency-recovery.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Map the provider-neutral `PreviewStore` contract to the selected Cloudflare storage and locking services. Preserve the same object keys, v1 records, immutable revision rules, catalog update order, and browser routes used by the directory and AWS adapters.

## Acceptance criteria

- Adapter operations distinguish confirmed object absence from authorization, transport, and partial-listing failures.
- Immutable objects use the provider's safe create-once behavior; mutable catalog replacement and per-site locking preserve concurrent group updates.
- Cloudflare credentials, object routing, and lock mechanics remain in the adapter/deployment boundary; preview-group or expiry decisions stay in the shared core.
- Provider fake and narrow live-account smoke checks cover idempotent retry, concurrent groups, lock loss, and interrupted writes without crossing site prefixes.
- T4 and T8 record Cloudflare serving, cache, access, and lifecycle evidence separately from AWS evidence.
