# IMP-32 — Cloudflare production provider adapter

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [T12](../technical-design/T12-cloudflare-production-mapping.md), [IMP-22](IMP-22-site-locks.md), [IMP-25](IMP-25-production-reconciler.md)
- Proves: provider contract and real-service conditional-write smoke

## Outcome

Publish the same registered site projection on the Cloudflare services selected by T12.

## Acceptance criteria

- Registry origin read, complete prefix listing, content sync, conditional per-site lock and unregister cache behavior satisfy the shared contracts.
- Adapter tests include pagination, partial failure/retry, metadata, and a real-service conditional-write race; differences from AWS stay at the adapter edge.
- Coordinate shared preview storage with [IMP-18](IMP-18-cloudflare-preview-adapter.md) without treating preview-only proof as production proof.
