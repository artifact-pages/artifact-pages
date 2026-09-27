# Backlog

This is the entry point for work that is not yet complete. Keep product defects, unresolved technical designs, and unverified contracts distinct: they have different definitions of `Done`.

| Track | Purpose | Open | In progress | Done |
| --- | --- | ---: | ---: | ---: |
| [Issues](issues/README.md) | Independently actionable product problems with evidence and acceptance criteria. | 0 | 0 | 0 |
| Technical design | Decisions about how to fulfill an accepted contract. | 2 | 1 | 0 |
| Verification | Tests or measurements needed to prove an accepted contract. | 5 | 0 | 0 |

The eight unfinished design and verification items below concern the **post-MVP preview feature**. They are not claims that preview publishing exists in the current Phase 1 product. The [specification](../specification.md#post-mvp-pre-publish-preview-contract) owns accepted behavior; the [preview decision register](../architecture/preview-decisions.md) records product decisions; the [publishing contract](../architecture/preview-publishing-contract.html) contains a proposed technical shape. Backlog files track unfinished work and its evidence, not a second specification.

## Status legend

| Status | Meaning | Completion rule |
| --- | --- | --- |
| `Open` | Not yet started. | — |
| `In progress` | Actively being worked on. | — |
| `Blocked` | Cannot proceed without a decision, dependency, or external change. | Record the blocker in the item. |
| `Done` | Outcome established. | For an issue, verify its acceptance criteria; for technical design, record the settled contract; for verification, link the actual test results or measurements. |
| `Deferred` | Deliberately postponed. | Design and verification items only; record when to revisit. |
| `Won't fix` | The problem will not be pursued. | Issues only; record why. |

Use an item's own status as the source of truth, and update this index when it changes. `P0`–`P3` priorities apply to [issues](issues/README.md), not automatically to technical design or verification. Keep one independently finishable question or proof per file. A product-level choice belongs in the specification and decision register, not silently in a technical-design item.

## Technical design

| Item | Status | Outcome needed |
| --- | --- | --- |
| [T1 — Preview catalog and revision-manifest contract](technical-design/T1-preview-record-contract.md) | In progress | Settle the schema, object keys, and PR provenance for fixed URLs. |
| [T2 — CLI and Action interface](technical-design/T2-cli-action-interface.md) | Open | Settle flag/input/output names and resource-include syntax. |
| [T3 — Provider-owned retention mapping](technical-design/T3-provider-retention.md) | Open | Map the administrator's retention rule to provider behavior. |

## Verification

| Item | Status | Evidence needed |
| --- | --- | --- |
| [T4 — Serving routes, cache, and access control](verification/T4-serving-boundary.md) | Open | Browser/provider proof of routing and authorization boundaries. |
| [T5 — Concurrency and recovery](verification/T5-concurrency-recovery.md) | Open | Deterministic lock, retry, and partial-failure tests. |
| [T6 — Preview resources and navigation](verification/T6-resources-navigation.md) | Open | HTML/Markdown fixtures and route/resource tests. |
| [T7 — Preview discovery performance](verification/T7-discovery-performance.md) | Open | Multi-site transfer, availability-check, memory, and paint measurements. |
| [T8 — Stale-reference cleanup](verification/T8-stale-reference-cleanup.md) | Open | Local/CI parity and provider-availability tests without PR-state checks. |
