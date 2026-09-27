# T7 — Preview discovery performance

- Status: Done
- Phase: Phase 1 local browser characterization complete for the tested envelope

## Contract to prove

Opening one site's Previews list or palette tab reads only that site's catalog and filters missing revision manifests. Measure the local browser cost across many sites and groups; no product performance threshold is currently defined, so record the tested envelope and limitations rather than claiming an SLA.

## Exit criteria

- [x] Measure selected-site catalog and manifest response-body bytes, JSON parse, manifest-availability checks, browser memory, and input-to-paint with many sites and many groups within one site.
- [x] Verify that opening one site's Previews never downloads another site's catalog.
- [x] Compare live, confirmed-missing, and provider-read-error candidates without treating an error as expiry.
- [x] Decide whether the measured local cost warrants a projection change; no local browser bottleneck requiring sharding was observed, so keep the current projection and do not add an application-managed expiry clock.

## Evidence

[`preview-discovery-benchmark.md`](../../research/preview-discovery-benchmark.md) records three runs each of the committed SRE fixture and synthetic 20-site scenarios with 100, 500, and 1,000 active-site groups. At 1,000 groups, the selected-site catalog plus manifest response bodies total 805.2 KB; list click-to-render p95 is 382.3 ms, palette tab-to-render p95 is 569.7 ms, palette typing-to-paint p95 is 68.0 ms, and the post-GC palette heap delta is 19.48 MiB. Each run requested exactly one selected-site catalog and one manifest per unique selected head, with no other-site preview requests. The synthetic data mixes live, 404, and 503 results.

No product SLA or numeric workload target is defined. These local results did not show a browser bottleneck that justifies changing the projection or introducing sharding. API responses were fulfilled in-process, so the measurements do not predict nginx, object-store, CDN, compression, or public-network latency. The [artifact palette benchmark](../../research/palette-search-benchmark.md) measures production artifact discovery/search and is not T7 evidence.

## Implementation links

[IMP-09 discovery](../implementation/IMP-09-discovery.md) provides the list, palette, lazy catalog load and manifest checks to measure. [IMP-01 records](../implementation/IMP-01-preview-records.md) supplies representative payloads. Only measured bottlenecks should create follow-up optimization work.
