# T1 — Preview catalog and revision-manifest contract

- Status: Open
- Phase: Post-MVP preview

## Design question

What are the exact versioned records and storage keys for a site-scoped discovery catalog and an immutable head-SHA revision? A fixed revision URL must retain unambiguous PR provenance even if more than one group refers to the same head SHA.

## Exit criteria

- [ ] Specify catalog and manifest fields, canonical paths, storage keys, and the relationship between a group and a revision in the [publishing contract](../../architecture/preview-publishing-contract.html#shape).
- [ ] Define how a direct fixed URL obtains PR provenance without assuming one head belongs to one PR.
- [ ] Validate a local producer/reader round trip, including same-head retry and a manifest removed by the provider.
- [ ] Update the [specification](../../specification.md#post-mvp-pre-publish-preview-contract) if the accepted browser-facing contract changes.

## Evidence

Not yet recorded. The current JSON examples are candidates, not a frozen schema.
