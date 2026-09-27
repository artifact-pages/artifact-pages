# Backlog

This is the entry point for work that is not yet complete. Keep product defects, unresolved technical designs, implementation slices, and unverified contracts distinct: they have different definitions of `Done`.

| Track | Purpose | Open | In progress | Done |
| --- | --- | ---: | ---: | ---: |
| [Issues](issues/README.md) | Independently actionable product problems with evidence and acceptance criteria. | 0 | 0 | 0 |
| Technical design | Decisions about how to fulfill an accepted contract. | 2 | 1 | 4 |
| [Implementation](implementation/README.md) | Independently reviewable slices for preview, registry, normal publish, providers, local contract tests and distribution. | 9 | 7 | 20 |
| Verification | Tests or measurements needed to prove an accepted contract. | 4 | 3 | 2 |

The 26 unfinished design, implementation, and verification items include registry administration, local edge/object-storage contract environments, AWS/Cloudflare, and distribution slices. Provider adapters and reference infrastructure are being implemented, but no linked provider delivery or clean-room verification is claimed complete. The [specification](../specification.md) owns accepted behavior; the [preview decision register](../architecture/preview-decisions.md) records preview decisions; the [publishing contract](../architecture/preview-publishing-contract.html) records its provider-neutral shape and proof boundary. Backlog files track unfinished work and its evidence, not a second specification.

## Status legend

| Status | Meaning | Completion rule |
| --- | --- | --- |
| `Open` | Not yet started. | — |
| `In progress` | Actively being worked on. | — |
| `Blocked` | Cannot proceed without a decision, dependency, or external change. | Record the blocker in the item. |
| `Done` | Outcome established. | For an issue or implementation item, verify its acceptance criteria; for technical design, record the settled contract; for verification, link the actual test results or measurements. |
| `Deferred` | Deliberately postponed. | Design, implementation and verification items only; record when to revisit. |
| `Won't fix` | The problem will not be pursued. | Issues only; record why. |

Use an item's own status as the source of truth, and update this index when it changes. `P0`–`P3` priorities apply to [issues](issues/README.md), not automatically to other tracks. Keep one independently finishable question, implementation slice, or proof per file. A product-level choice belongs in the specification and decision register, not silently in a backlog item.

## Technical design

| Item | Status | Outcome needed |
| --- | --- | --- |
| [T1 — Preview catalog and revision-manifest contract](technical-design/T1-preview-record-contract.md) | Done | Settle and round-trip the v1 schema and keys locally. |
| [T2 — CLI and Action interface](technical-design/T2-cli-action-interface.md) | Open | Settle flag/input/output names and resource-include syntax. |
| [T3 — Provider-owned retention mapping](technical-design/T3-provider-retention.md) | Done | Map the administrator's retention rule to provider behavior. |
| [T9 — Cloudflare store and lock mapping](technical-design/T9-cloudflare-store-mapping.md) | In progress | Select Cloudflare services that implement the shared storage and lock contract. |
| [T10 — Configuration locator and precedence](technical-design/T10-config-location.md) | Done | Settle local/remote config forms and precedence without coupling satellites to admin YAML. |
| [T11 — Registry, site and application command surface](technical-design/T11-command-surface.md) | Done | Settle public commands, dry-run outputs and Action boundary. |
| [T12 — Cloudflare production deployment mapping](technical-design/T12-cloudflare-production-mapping.md) | Open | Select Cloudflare services for production storage, locking, delivery and cache. |

## Implementation

The [implementation index](implementation/README.md) lists 36 scoped tickets with dependencies and acceptance criteria. IMP-01–18 cover preview; IMP-19–35 cover the other accepted product surfaces; IMP-36 establishes the local storage/edge contract test foundation. Backlog status does not expand the current Phase 1 boundary by itself.

## Verification

| Item | Status | Evidence needed |
| --- | --- | --- |
| [T4 — Serving routes, cache, and access control](verification/T4-serving-boundary.md) | In progress | Provider cache and public/restricted serving proof. |
| [T5 — Concurrency and recovery](verification/T5-concurrency-recovery.md) | In progress | Cross-process locks, concurrent updates, and injected-failure tests. |
| [T6 — Preview resources and navigation](verification/T6-resources-navigation.md) | Done | Local resource and navigation contract verified. |
| [T7 — Preview discovery performance](verification/T7-discovery-performance.md) | Done | 20-site local browser measurements through 1,000 active-site groups; see the report for scope and limitations. |
| [T8 — Stale-reference cleanup](verification/T8-stale-reference-cleanup.md) | In progress | CI wrapper parity and AWS/Cloudflare provider-origin cleanup; local ordering and retry are evidenced. |
| [T13 — Registered admin and satellite flow](verification/T13-registered-flow.md) | Open | Strict registry projection and separate-checkout local workflow. |
| [T14 — Production reconciliation and race safety](verification/T14-production-reconciliation.md) | Open | Locks, orderings, failure/retry, pagination and source-tree boundaries. |
| [T15 — AWS and Cloudflare delivery boundaries](verification/T15-provider-delivery.md) | Open | Real-provider routes, cache, access and invalidation. |
| [T16 — Clean-room distribution and upgrade](verification/T16-external-adoption.md) | Open | External repositories using pinned released components and rollback. |
