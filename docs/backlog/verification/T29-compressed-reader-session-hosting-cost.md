# T29 — Compressed reader-session hosting cost re-estimate

- Status: Done
- Assignee: Codex
- Phase: Pre-launch
- Scope: Measure compressed reader sessions and recalculate the existing AWS and R2 hosting cost scenarios.
- Design decision: use a fixed-order sequential waterfall, recalculating provider pricing after each step and applying the free tiers at each intermediate subtotal. Hold the scenario, miss rate, prices, and invalidation conditions fixed; do not assign an unexplained residual to a factor.
  1. Compression: keep document views cold for every page view and replace the old body size with the new compressed size; leave search, billable requests, and storage unchanged.
  2. Session reuse: replace V×C with (V/3)×(C+2W), with reloads=0; keep legacy billable request counts.
  3. Search treatment: replace the shared broad/warm-short extra body with per-size independent first broad/short bodies; keep search counts and mix.
  4. Request count: switch viewer/origin requests and cache classes to the new vector; add 1,024 B per network response, count 200/304, exclude browser-cache hits, and include publisher-request remeasurement.
  5. Storage: replace legacy projection plus private state with new per-provider storage.
  The steps are order-dependent model substitutions, not independent causal effects. Compression includes the cold-body remeasurement difference and is not a pure compression effect.

## Exit criteria

- [x] Capture three reader iterations per 1k, 5k, and 50k fixture: initial document, two SPA navigations, normal reload, and separate broad/short search clients. The raw results preserve response status, actual request headers, and conditional-header evidence.
- [x] Capture plain and AWS-policy publisher projections for all three fixture sizes; generated index and manifest validation passed.
- [x] Record all nine S/M/L × 10%/50%/100% monthly rows with R2 gross and dedicated-free subtotals and AWS storage, publisher requests, reader-origin requests, viewer requests, transfer, and invalidation components. Each AWS subtotal reconciles to its components.
- [x] Record decoded, stored, gzip6, and Brotli5 bytes by object type; include network 304 counts and modeled response-header bytes/cost.
- [x] Record one-factor sensitivities for q=1/3/5, gzip6/Brotli5, reloads 0/1, index unchanged/changed on reload, and 512/1,024/2,048-byte response headers, each with its effective assumptions.
- [x] Compute the legacy-to-current waterfall from the legacy table in fixed order: compression → sessionReuse → searchTreatment → requestCount → storage. The unrounded steps reconcile to the new endpoint for AWS US/Canada, AWS PriceClass 100, R2 gross, and R2 after dedicated free allowance for each size/miss-rate scenario.
- [x] Record measurement conditions, source commit, environment and tool versions, generator version/seed, prices, and unmeasured scope in the report and results JSON; link the T29 evidence from T27. The measurement used script content identical to `b9847b9e0a6104ca2428486f8bd56460821cba95`.

## Evidence

Follow-up: the 2026-10-24 owner-approved [IMP-82](../implementation/IMP-82-cli-owned-cache-policy.md) removes invalidation and adopts a fixed CLI-owned cache policy. [T30](T30-cache-freshness-and-root-latency.md) measures provider freshness/root latency; its class-based origin-rate/cost follow-up feeds [T27](T27-launch-hosting-cost-model.md). This ticket remains Done for the fixed-condition local re-estimate below; its uniform miss-rate scenarios do not establish long-tail body hit rates or live provider behavior.

[Hosting cost model](../../research/hosting-cost-model.md) contains the current S/M/L × miss-rate tables, component subtotals, C/W/R vectors, per-object compression audit, 304/header accounting, complete one-factor sensitivity table, and legacy waterfall. The October 18 inputs are retained in the [legacy snapshot](../../research/hosting-cost-model-legacy-2026-10-18.md).

- [Reader measurement results](../../research/hosting-cost-reader-session-results.json): three iterations for 1k/5k/50k, fresh context, three document actions separated by 45 seconds, reload, separate quiet search clients, and CDP response/header evidence. The 648 retained responses include 61 304 responses; all 61 have If-None-Match and/or If-Modified-Since evidence. The run records Darwin arm64 / Apple M4, Node v22.14.0, Go 1.26.10, CLI 0.5.2, Chromium 153.0.8010.12, Playwright 1.63.0, nginx 1.29-alpine, generator v2 / seed 20261014, and a clean source tree at `b9847b9e0a6104ca2428486f8bd56460821cba95`.
- [Calculated model results](../../research/hosting-cost-model-results.json): nine modeled rows, all effective sensitivity assumptions, six AWS cost components, and every legacy/new waterfall intermediate. The calculator verifies the legacy table at cent precision and checks each decomposition endpoint against the new model.

At 10% miss, AWS US/Canada totals are S $4.02, M $117.07, L $160.29; R2 gross totals are S $0.07, M $1.46, L $3.95. AWS transfer is $0 for all three base sizes; L measures 877.05 GB, about 123 GB below the modeled 1 TB free tier, and is sensitive to session/reload assumptions. At 100% miss, L is AWS US/Canada $173.48 and R2 gross $15.82. Invalidation is $3.95 / $115.45 / $125.11 for S/M/L. These are local measured-unit estimates, not provider bills. CloudFront Functions, preview lifecycle, registry sync, and app-deploy provider activity remain unmeasured and excluded.
