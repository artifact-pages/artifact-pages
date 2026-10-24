# Verification backlog

Each ticket records one independently verifiable contract or measurement. Status lives in the ticket and is repeated here for navigation; update both when it changes.

Shared execution preparation: [October 18 provider-proof plan](provider-proof-plan-2026-10-18.md) and [hosted fixture preparation](hosted-fixture-preparation-2026-10-18.md). The [October 20 decision](provider-proof-plan-2026-10-18.md#superseding-execution-decision--october-20-2026) retires the harness/signatures/registry gates: Claude main executes direct reviewed commands with chat OK within the existing A1–A9 scopes and caps. Unsupported P4–P7 faults stay open/not-run; the earlier full-Cloudflare-refresh gate is historical (see the later precondition/final configuration comparisons). The [October 24–25 Cloudflare A6/A7 result and restoration](provider-proof-plan-2026-10-18.md#cloudflare-a6a7-execution-result--october-2425-2026) now record scoped local samples, not hosted Actions/OIDC; unsupported faults and aggregate criteria remain open. Future post-publication/pre-rollout regression is [IMP-81](../implementation/IMP-81-provider-release-regression-workflow.md) / [T28](T28-provider-release-regression.md), with separate future live authorization.

| Ticket | Status | Verification |
| --- | --- | --- |
| [T4](T4-serving-boundary.md) | In progress | Serving routes and cache |
| [T5](T5-concurrency-recovery.md) | In progress | Concurrency and recovery |
| [T6](T6-resources-navigation.md) | Done | Preview resources and navigation |
| [T7](T7-discovery-performance.md) | Done | Preview discovery performance |
| [T8](T8-stale-reference-cleanup.md) | In progress | Stale-reference cleanup |
| [T13](T13-registered-flow.md) | Done | Registered admin and satellite flow |
| [T14](T14-production-reconciliation.md) | In progress | Production reconciliation and race safety |
| [T15](T15-provider-delivery.md) | In progress | AWS and Cloudflare delivery boundaries |
| [T16](T16-external-adoption.md) | Open | Clean-consumer adoption of released components, web upgrade and rollback |
| [T17](T17-local-preview-retirement-e2e.md) | Done | Local preview deletion and main-publish reconciliation E2E |
| [T18](T18-publish-scale-baseline.md) | Done | Publisher scale baseline and state-manifest comparison |
| [T19](T19-publish-state-layout-cost.md) | Done | Publish-state layout and provider-cost comparison |
| [T20](T20-publish-state-and-candidate.md) | Done | Fused publish-state recovery and candidate validation |
| [T21](T21-command-cost-audit.md) | Done | CLI command and workflow cost audit |
| [T22](T22-cache-purge-retry.md) | Done | Registry and app deploy cache purge retry |
| [T23](T23-private-repository-topology.md) | Done | Private-repository deepen fetch, private admin config token (with a CI regression check), preview checks and plan limits |
| [T24](T24-pre-launch-browser-and-keyboard-matrix.md) | Open | Pre-launch browser, phone and keyboard matrix |
| [T25](T25-web-first-load-and-search-at-scale.md) | In progress | Web first load and search at the advertised site size |
| [T26](T26-cli-publish-memory-vs-source-bytes.md) | Done | CLI publish peak memory against source bytes |
| [T27](T27-launch-hosting-cost-model.md) | In progress | Launch hosting cost model from recorded request counts and storage |
| [T28](T28-provider-release-regression.md) | Open | Post-publication real-provider release regression and preservation/cleanup evidence |
| [T29](T29-compressed-reader-session-hosting-cost.md) | Done | Compressed reader-session hosting cost re-estimate |
| [T30](T30-cache-freshness-and-root-latency.md) | Open | No-invalidation delivery proof and 5-or-0-second shared-root latency decision for [IMP-82](../implementation/IMP-82-cli-owned-cache-policy.md); T29 baseline / T27 cost follow-up |
| [T31](T31-reserved-text-content-type.md) | Open | Cross-provider reserved-name .txt MIME, stored/delivered metadata and reader behavior; A6 observation matches saved AWS evidence. |
