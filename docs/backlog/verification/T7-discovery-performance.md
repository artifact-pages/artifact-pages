# T7 — Preview discovery performance

- Status: Open
- Phase: Post-MVP preview

## Contract to prove

Opening one site's Previews list or palette tab reads only that site's catalog and filters missing revision manifests without an unacceptable delay or memory cost at multi-site scale.

## Exit criteria

- [ ] Measure catalog transfer and parse, manifest-availability checks, browser memory, and input-to-paint with many sites and many groups within one site.
- [ ] Verify that opening one site's Previews never downloads another site's catalog.
- [ ] Compare live, confirmed-missing, and provider-read-error candidates without treating an error as expiry.
- [ ] If the observed cost is unacceptable, revise the discovery projection without adding an application-managed expiry clock.

## Evidence

Not yet measured. The [artifact palette benchmark](../../research/palette-search-benchmark.md) measures production artifact discovery/search; it does not include preview catalogs or revision-manifest availability checks and is not T7 evidence. The current browser has no preview list/catalog reader, and T1's record schema is still in progress, so transfer, parse, availability-check, memory, and paint costs cannot yet be measured against the contract. Keep T7 separate from the production palette benchmark.

## Implementation links

[IMP-09 discovery](../implementation/IMP-09-discovery.md) provides the list, palette, lazy catalog load and manifest checks to measure. [IMP-01 records](../implementation/IMP-01-preview-records.md) supplies representative payloads. Only measured bottlenecks should create follow-up optimization work.
