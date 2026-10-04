# TD6 — Fused publish-state transaction journal

- Status: Done
- Phase: Provider-neutral publisher contract
- Decided: 2026-10-04
- Related implementation: [IMP-49](../implementation/IMP-49-fused-publish-state-journal.md)
- Related verification: [T20](../verification/T20-publish-state-and-candidate.md), [T19](../verification/T19-publish-state-layout-cost.md)
- Product contract: [Specification §5.3](../../specification.md#per-site-publish-state-and-reconciliation)

## Decision

Keep one flat, compressed per-site inventory. Use the existing retry record as the durable transaction journal instead of writing a pending copy of the full inventory. The shared publisher owns the state machine, diff, ordering and recovery rules. An adapter may select a supported state-read mode: Cloudflare R2 reads state with one GET; other adapters retain HEAD followed by GET and verify the same ETag. This is a narrow request capability, not provider-specific transaction logic or automatic cost tuning.

Do not add directory nodes, shards, or a second diff engine. T19 found their sparse-update byte savings could be outweighed by additional billed requests and retained state under the measured R2 workloads. The flat layout remains authoritative until a separate reviewed decision changes it.

## Records

The private root remains `_control/publish-state/<site>.json.gz`. Schema 1 contains the site ID, committed input fingerprint, last committed origin transaction generation, and sorted object rows. Rows bind in-scope object keys to SHA-256, byte size, and the complete HTTP representation metadata (`Content-Type`, `Content-Encoding`, `Content-Disposition`, `Cache-Control`). The compressed body is deterministic and bounded. Object metadata binds the schema, input root, generation, site, digest and the non-pending state.

The existing `_control/site-cache/<site>.json` record becomes the transaction journal. Its schema-1 form contains sorted invalidation paths and, for an in-flight origin transaction, a random transaction ID, its base committed generation, and the sorted union of every projection key that may have been written or removed. A record without a transaction may still carry cache-only work. The prerelease reader accepts the current schema-1 shape only; an earlier shape with the same schema integer fails closed with target-scoped reset guidance and is never silently inventoried or deleted.

## Publish and recovery sequence

Under the existing cooperative site lock, validate registration, read/classify the journal, prepare the source, then read and validate the root using the selected adapter mode. A root generation equal to the journal transaction ID proves the origin commit completed; a base generation equal to the journal base means the transaction is still pending and every touched key must be replayed against the latest desired source. Any other generation fails closed. The touched set is monotone while that transaction remains unresolved, including when a later source reverts or omits a key touched by an interrupted write.

Persist journal intent with conditional write before changing origin objects. Upload source files, then immutable search blobs, then generated index/search-manifest/meta objects in dependency order, then delete stale objects. Commit the compact root with conditional write only after the origin projection succeeds. Root-only fingerprint changes retain the last origin generation so an outstanding cache-only journal remains classifiable. Keep the journal until preview-catalog reconciliation and cache invalidation succeed; then remove it. Do not infer that a conditional write failed to persist from an error response. The next invocation resolves ambiguous journal/root responses from the persisted generation and retries idempotently.

Dry-run is read-only and may plan recovery; it does not rewrite records, mutate origin data, invalidate caches, or delete the journal. A missing root uses complete artifact/index listings and HEADs only listed objects before first managed commit. An explicit `--reconcile` remains the repair path for out-of-band origin drift; normal successful-state publishes trust the committed inventory.

## Release boundary

This changes private CLI control records only. Public registry, metadata, index, preview, full-text and browser behavior remain unchanged. The pre-release stream has no promised private-control compatibility; reset only the selected site's two private control keys after backing them up and confirming there is no publish or cache retry in progress. This CLI never performs that reset automatically. The product candidate version is tracked separately from the private record schema.
