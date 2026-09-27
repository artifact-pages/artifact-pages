# IMP-09 — Site-local preview discovery

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-01](IMP-01-preview-records.md), [IMP-07](IMP-07-local-serving.md); fixture catalog can precede publication.
- Proves: [T7](../verification/T7-discovery-performance.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Add the quiet site-home link, dedicated Previews list and separate in-site palette tab. Read only the active site's catalog when entering preview surfaces. The optional group-list URL resolves through the latest catalog entry, unlike revision-specific document URLs.

## Acceptance criteria

- Previews do not enter production Browse, Recently updated or normal page search. Empty/missing group and missing manifest show appropriate empty states.
- Validate candidate manifests before presenting entries; confirmed missing is hidden, provider read error is not falsely classified as expiry.
- No other site's catalog loads when one site opens Previews. Multi-site/group transfer, parse, memory and input-to-paint are measured under T7 before introducing sharding.
- List and palette navigate to revision-specific documents; loading/error states do not block the rest of the site.
