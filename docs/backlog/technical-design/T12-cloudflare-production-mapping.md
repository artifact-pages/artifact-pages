# T12 — Cloudflare production deployment mapping

- Status: Open
- Phase: Provider-backed deployment

## Design question

Which Cloudflare storage, conditional-write/lock, static delivery, cache, access, and deployment services satisfy the same production contract as the AWS adapter?

## Exit criteria

- [ ] Map registry reads, per-site complete listings, object writes/deletes, conditional lock updates, and invalidation/revalidation to concrete Cloudflare APIs.
- [ ] Show application-plane and content-plane routing, cache freshness, optional viewer controls, and role/credential separation.
- [ ] Record limitations and a real-service smoke test for conditional writes before promising equivalent behavior.
- [ ] Reuse [T9](T9-cloudflare-store-mapping.md) where preview and production share a store, without silently extending preview-specific assumptions.

## Evidence

Not yet recorded. This is a provider design gate, not a claim that an adapter exists.
