# T9 — Cloudflare preview store and lock mapping

- Status: In progress
- Phase: Post-MVP provider deployment

## Design question

Which Cloudflare storage, origin-read, and cooperative-lock capabilities should implement the provider-neutral `PreviewStore` contract? Keep the canonical records, object keys, immutable/mutable semantics, publication order, and site-scoped lock contract shared with the local and AWS implementations.

## Selected mapping

- Store preview records and files in Cloudflare R2 through its S3-compatible API at `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, with region `auto`. `internal/publisher.ObjectPreviewStore` adapts the shared object and conditional-write interface to the domain-level `preview.PreviewStore`; preview keys and publication rules remain provider-neutral.
- Use R2 `GetObject` for origin reads, `PutObject` with `If-None-Match: *` for immutable files/manifests, and the same retained `_control/locks/sites/<site>.json` ETag compare-and-swap record used by registered site publication. Use `PutObject` for the mutable catalog while holding that lock.
- Translate only confirmed missing-key responses to `ErrObjectNotFound`. Authorization, transport, malformed response, and partial-list errors remain failures. The shared adapter follows every `ListObjectsV2` continuation page and checks each batched delete response.
- Preview catalog objects use short mutable cache freshness; revision manifests and files keep bounded revalidation until retention and delivery verification settle. R2 object-lifecycle policy owns removal; the application does not write expiry timestamps.

The official R2 compatibility table currently lists `GetObject`, `HeadObject`, `PutObject`, `ListObjectsV2`, and conditional `If-Match`/`If-None-Match` operations. That is a capability match, not a real-service race proof. See [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/) and [R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/).

## Exit criteria

- [x] Select the Cloudflare services and credentials for object storage, static serving, and per-site locking without introducing Cloudflare-specific concepts into the preview domain model.
- [x] Map confirmed object absence separately from access, transport, and partial-listing failures.
- [ ] Define safe immutable create-once and mutable catalog replacement behavior, including retry and lock-loss semantics.
- [ ] Link adapter, serving, and retention decisions to [IMP-18](../implementation/IMP-18-cloudflare-preview-adapter.md), [IMP-14](../implementation/IMP-14-provider-serving.md), [IMP-15](../implementation/IMP-15-provider-retention.md), and T4/T5/T8 evidence.

## Evidence

`internal/publisher.ObjectPreviewStore` implements the shared immutable-write, mutable-catalog, origin-read, and site-lock mapping over `publisher.ConditionalObjectBackend`; reconciliation decisions remain in `internal/preview`. The provider mapping is selected; IMP-18 and verification T4/T5/T8 still need adapter tests and a real R2 conditional-write smoke before this design closes.
