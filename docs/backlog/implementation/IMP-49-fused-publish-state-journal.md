# IMP-49 — Publish state and fused transaction journal

- Status: In progress
- Phase: Provider-neutral publisher
- Design: [TD6](../technical-design/TD6-fused-publish-state.md)
- Product contract: [Specification §5.3](../../specification.md#per-site-publish-state-and-reconciliation)
- Verification: [T20](../verification/T20-publish-state-and-candidate.md)

Replace the duplicated full-manifest pending write with a compact transaction record in the existing per-site cache-retry journal. Keep the committed flat object inventory and make provider read behavior an explicit capability.

## Acceptance criteria

- [x] Schema-1 root and journal are bounded, validated, site-scoped, and bound to their HTTP metadata and conditional ETags. Older private-control shapes fail closed with target-scoped reset guidance; no automatic migration is performed.
- [x] Every origin mutation follows durable journal intent; origin state commits only after ordered projection writes and stale deletes succeed.
- [x] Transaction generations distinguish pending replay from an origin commit whose response was lost. Touched-key and cache-path unions survive changed/reverted retries.
- [x] Cloudflare R2 uses one complete state GET; AWS/default adapters retain HEAD then GET and ETag agreement.
- [x] Existing publish behavior remains provider-neutral: lock/registry validation, dry-run, source ordering, cache retry, preview reconciliation, explicit repair and unregister cleanup remain in the shared publisher.
- [ ] Dedicated failure-boundary tests, package/race suites, compatibility/package preflight and verification-target R2 publish/no-op evidence are recorded in T20.

The implementation is local and does not publish a tag, release asset, or infrastructure change.
