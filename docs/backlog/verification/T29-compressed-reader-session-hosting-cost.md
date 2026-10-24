# T29 — Compressed reader-session hosting cost re-estimate

- Status: Done
- Assignee: Codex
- Phase: Pre-launch
- Scope: Measure compressed reader sessions and recalculate the existing AWS and R2 hosting cost scenarios.
- Source: `docs-planning/aws-cost/sol-design.md`, sections 1–2

## Exit criteria

- [x] Capture three reader iterations per 1k, 5k, and 50k fixture: initial document, two SPA navigations, normal reload, and separate broad/short search clients. The raw results preserve response status, actual request headers, and conditional-header evidence.
- [x] Capture plain and AWS-policy publisher projections for all three fixture sizes; generated index and manifest validation passed.
- [x] Record all nine S/M/L × 10%/50%/100% monthly rows with R2 gross and dedicated-free subtotals and AWS storage, publisher requests, reader-origin requests, viewer requests, transfer, and invalidation components. Each AWS subtotal reconciles to its components.
- [x] Record decoded, stored, gzip6, and Brotli5 bytes by object type; include network 304 counts and modeled response-header bytes/cost.
- [x] Record one-factor sensitivities for q=1/3/5, gzip6/Brotli5, reloads 0/1, index unchanged/changed on reload, and 512/1,024/2,048-byte response headers, each with its effective assumptions.
- [x] Compute the legacy-to-current waterfall from the legacy table in fixed order: compression → sessionReuse → searchTreatment → requestCount → storage. The unrounded steps reconcile to the new endpoint for AWS US/Canada, AWS PriceClass 100, R2 gross, and R2 after dedicated free allowance for each size/miss-rate scenario.
- [x] Record measurement conditions, source commit, environment and tool versions, generator version/seed, prices, and unmeasured scope in the report and results JSON; link the T29 evidence from T27.

## Evidence

[Hosting cost model](../../research/hosting-cost-model.md) contains the current S/M/L × miss-rate tables, component subtotals, C/W/R vectors, per-object compression audit, 304/header accounting, complete one-factor sensitivity table, and legacy waterfall. The October 18 inputs are retained in the [legacy snapshot](../../research/hosting-cost-model-legacy-2026-10-18.md).

- [Reader measurement results](../../research/hosting-cost-reader-session-results.json): three iterations for 1k/5k/50k, fresh context, three document actions separated by 45 seconds, reload, separate quiet search clients, and CDP response/header evidence. The 648 retained responses include 61 304 responses; all 61 have If-None-Match and/or If-Modified-Since evidence. The run records Darwin arm64 / Apple M4, Node v22.14.0, Go 1.26.10, CLI 0.5.2, Chromium 153.0.8010.12, Playwright 1.63.0, nginx 1.29-alpine, generator v2 / seed 20261014, and a clean source tree at `b9847b9e0a6104ca2428486f8bd56460821cba95`.
- [Calculated model results](../../research/hosting-cost-model-results.json): nine modeled rows, all effective sensitivity assumptions, six AWS cost components, and every legacy/new waterfall intermediate. The calculator verifies the legacy table at cent precision and checks each decomposition endpoint against the new model.

At 10% miss, AWS US/Canada totals are S $4.02, M $117.07, L $163.25; R2 gross totals are S $0.07, M $1.46, L $3.95. AWS transfer is $0 for S/M under the modeled 1 TB free tier and $2.96 for L. Invalidation is $3.95 / $115.45 / $125.11 for S/M/L. These are local measured-unit estimates, not provider bills. CloudFront Functions, preview lifecycle, registry sync, and app-deploy provider activity remain unmeasured and excluded.
