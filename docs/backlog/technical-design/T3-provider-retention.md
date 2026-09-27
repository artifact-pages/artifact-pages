# T3 — Provider-owned retention mapping

- Status: Done
- Phase: Post-MVP preview

## Design question

How does an administrator's single preview-retention policy map to AWS and Cloudflare provider-managed removal of revision files, manifests, the mutable catalog, and any retained object versions? The application must not invent its own expiry clock.

## Settled contract

- Configure one positive `previewRetentionDays` value per deployment. Do not set per-PR retention values or store an application expiry timestamp.
- Apply provider lifecycle expiration to the whole `_previews/` prefix. AWS uses S3 lifecycle expiration; Cloudflare uses an R2 object-lifecycle rule with the same prefix. Normal site publish and unregister do not change this rule.
- Provider lifecycle processing is asynchronous. A catalog can temporarily reference a manifest that has expired; readers handle a missing revision, and catalog pruning removes the stale reference only after origin confirms absence.
- Disable object versioning for the preview prefix. If S3 versioning is enabled for operational reasons, expire noncurrent preview versions under the same policy so a replaced or deleted preview does not remain billable indefinitely. R2 lifecycle rules are prefix-scoped and provider-managed.
- When a site stops pre-publishing, its preview objects still age out under the same prefix rule. Unregister removes the site's preview data immediately as part of explicit cleanup.

Provider behavior references: [S3 lifecycle expiration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html) and [R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/). R2 documents that lifecycle removal is typically completed within 24 hours, so the shared contract promises a retention policy, not an exact deletion time.

## Exit criteria

- [x] Define the provider configuration and object-prefix boundaries for preview retention in both AWS and Cloudflare without a per-PR duration or application expiry timestamp.
- [x] Explain what happens when an old manifest disappears before a catalog reference and when a site stops pre-publishing entirely.
- [x] Check that retained object versions do not make preview storage grow indefinitely under the proposed provider setup.
- [x] Keep the [provider-neutral contract](../../architecture/preview-publishing-contract.html#expiry) separate from adapter-specific instructions.

## Evidence

This design selects provider-owned `_previews/` lifecycle rules and no application expiry clock. IMP-15 must implement the rules, while T4/T8 verify provider timing and stale-catalog handling.

## Implementation links

The provider-specific mapping gates [IMP-15 provider retention configuration](../implementation/IMP-15-provider-retention.md); [T9](T9-cloudflare-store-mapping.md) separately settles Cloudflare storage and lock service choices. See the [implementation index](../implementation/README.md) for dependencies. Local projection, reader and discovery tickets can proceed before either provider design is closed.
