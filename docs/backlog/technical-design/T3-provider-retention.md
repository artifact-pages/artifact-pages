# T3 — Provider-owned retention mapping

- Status: Open
- Phase: Post-MVP preview

## Design question

How does an administrator's single preview-retention policy map to provider-managed removal of revision files, manifests, the mutable catalog, and any retained object versions? The application must not invent its own expiry clock.

## Exit criteria

- [ ] Define the provider configuration and object-prefix boundaries for preview retention without a per-PR duration or application expiry timestamp.
- [ ] Explain what happens when an old manifest disappears before a catalog reference and when a site stops pre-publishing entirely.
- [ ] Check that retained object versions do not make preview storage grow indefinitely under the proposed provider setup.
- [ ] Keep the [provider-neutral contract](../../architecture/preview-publishing-contract.html#expiry) separate from adapter-specific instructions.

## Evidence

Not yet recorded. Provider configuration and its observed removal timing remain to be proved.
