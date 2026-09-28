# Backlog

This is the entry point for work that is not yet complete. Keep product defects, unresolved technical designs, implementation slices, and unverified contracts distinct: they have different definitions of `Done`.

| Track | Purpose | Open | In progress | Blocked | Done |
| --- | --- | ---: | ---: | ---: | ---: |
| [Issues](issues/README.md) | Independently actionable product problems with evidence and acceptance criteria. | 1 | 0 | 0 | 0 |
| Technical design | Decisions about how to fulfill an accepted contract. | 0 | 1 | 0 | 8 |
| [Implementation](implementation/README.md) | Independently reviewable slices for preview, registry, normal publish, providers, local contract tests and distribution. | 0 | 0 | 0 | 36 |
| Verification | Tests or measurements needed to prove an accepted contract. | 2 | 4 | 0 | 3 |

The 7 unfinished design, implementation, and verification items cover component release policy and remaining provider-delivery, recovery, and external-adoption proof. Viewer access is an operator-managed edge concern, not a product-level site policy. Provider adapters and reference infrastructure are implemented locally, but no linked provider delivery or external clean-room verification is claimed complete. The [specification](../specification.md) owns accepted behavior; the [preview decision register](../architecture/preview-decisions.md) records preview decisions; the [publishing contract](../architecture/preview-publishing-contract.html) records its provider-neutral shape and proof boundary. Backlog files track unfinished work and its evidence, not a second specification.

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
| [T2 — CLI and Action interface](technical-design/T2-cli-action-interface.md) | Done | Settle flag/input/output names and resource-include syntax. |
| [T3 — Provider-owned retention mapping](technical-design/T3-provider-retention.md) | Done | Map the administrator's retention rule to provider behavior. |
| [T9 — Cloudflare store and lock mapping](technical-design/T9-cloudflare-store-mapping.md) | Done | Select Cloudflare services that implement the shared storage and lock contract. |
| [T10 — Configuration locator and precedence](technical-design/T10-config-location.md) | Done | Settle local/remote config forms and precedence without coupling satellites to admin YAML. |
| [T11 — Registry, site and application command surface](technical-design/T11-command-surface.md) | Done | Settle public commands, dry-run outputs and Action boundary. |
| [T12 — Cloudflare production deployment mapping](technical-design/T12-cloudflare-production-mapping.md) | Done | Select Cloudflare storage, locking, delivery, cache, and credential boundaries; live provider proof remains. |
| [TD1 — Viewer access is an operator-managed edge concern](technical-design/TD1-site-viewer-access.md) | Done | Establish that Artifact Pages has no viewer identity or per-site authorization model. |
| [TD2 — Component licensing and release compatibility](technical-design/TD2-component-release-policy.md) | In progress | Record the selected MIT license, complete license/notice files, and settle component release/version compatibility before public release. |

## Implementation

The [implementation index](implementation/README.md) lists 36 scoped tickets with dependencies and acceptance criteria. IMP-01–18 cover preview; IMP-19–35 cover the other accepted product surfaces; IMP-36 establishes the local storage/edge contract test foundation. Backlog status does not expand the current Phase 1 boundary by itself.

## Remaining workstreams

The implementation slices are complete. The remaining work is grouped here by delivery outcome; the linked design and verification files remain the status source of truth.

| Workstream | Current state | Remaining outcome |
| --- | --- | --- |
| Component release and adoption | CLI, app bundle, and optional Actions are implemented locally ([IMP-31](implementation/IMP-31-app-distribution.md), [IMP-34](implementation/IMP-34-actions.md)); [TD2](technical-design/TD2-component-release-policy.md) and [T16](verification/T16-external-adoption.md) remain open. | Add the selected MIT license and required notices; settle immutable release/version policy and cross-component compatibility; then verify adoption from clean external repositories using released pins, including upgrade and rollback. |
| GitHub Actions | Thin admin and explicit-site composite Actions plus caller-owned workflow templates exist. No reusable workflow is required or provided. | Publish a reviewed immutable Action ref and verify hosted/released-component use as part of T16. Adopters retain control of triggers, approvals, and credential policy. |
| Provider infrastructure | AWS and Cloudflare reference infrastructure sources are implemented ([IMP-30](implementation/IMP-30-aws-deployment-module.md), [IMP-33](implementation/IMP-33-cloudflare-deployment.md)); live delivery evidence remains in [T15](verification/T15-provider-delivery.md). | Validate real-provider routes, cache behavior, access isolation, OIDC scopes, and invalidation. GCP currently has a local emulator profile only; a production GCP adapter/module is not in the current supported-provider scope. |
| Publish reliability and cleanup | Local implementation and recovery paths are complete. | Finish provider and failure-recovery evidence in [T4](verification/T4-serving-boundary.md), [T5](verification/T5-concurrency-recovery.md), [T8](verification/T8-stale-reference-cleanup.md), and [T14](verification/T14-production-reconciliation.md). |

## First public release order

This is the recommended gate order for a usable public release. The linked backlog items remain the source of status and acceptance criteria; this sequence does not duplicate them.

1. **Set the release contract — [TD2](technical-design/TD2-component-release-policy.md).** Record the selected MIT license and required notices; define the components to publish, immutable version/ref rules, compatibility expectations, and retirement/rollback policy. Include the CLI, web bundle, Actions, deployment configuration, schemas, and supported Terraform modules. This blocks publishing a release candidate.
2. **Complete supported-provider proof — [T4](verification/T4-serving-boundary.md), [T5](verification/T5-concurrency-recovery.md), [T8](verification/T8-stale-reference-cleanup.md), [T14](verification/T14-production-reconciliation.md), and [T15](verification/T15-provider-delivery.md).** Close the provider and recovery evidence for every provider advertised as supported. The current target is AWS and Cloudflare; `gcp-local` remains emulator-only. These checks can proceed alongside TD2 when provider test environments are available; no cloud account or credentials are assumed to exist.
3. **Publish a release candidate from the policy-approved commit.** Produce the selected versioned CLI/app/module references and the web archive, manifest, and checksum. Ensure the public setup guide surfaces the existing HTML/Markdown trust model and upgrade/rollback instructions. The current repository has local packaging and deployment paths, but no public release or immutable Artifact Pages Action ref has been exercised.
4. **Verify the candidate in clean consumer repositories — [T16](verification/T16-external-adoption.md).** Use the published pins from separate admin and satellite repositories; verify registry/site dry-run and publish, app deployment, optional Action parity, and app upgrade/rollback without changing site content. Repeat locally and on AWS as T16 specifies; Cloudflare provider delivery remains covered by T15. Do not call the supported workflow generally ready until those proofs pass.
5. **Publish the stable release and its support statement.** Do this only after TD2, the selected providers' proof, and T16 pass. Keep GCP out of the support statement unless a production adapter and its evidence are separately added.

The P2 [site-description issue](issues/ISSUE-013-site-description.md) is product polish, not a release gate under the current roadmap.

## Verification

| Item | Status | Evidence needed |
| --- | --- | --- |
| [T4 — Serving routes and cache](verification/T4-serving-boundary.md) | In progress | Provider route, cache, and invalidation proof; viewer access is operator-managed. |
| [T5 — Concurrency and recovery](verification/T5-concurrency-recovery.md) | In progress | Cross-process locks, concurrent updates, and injected-failure tests. |
| [T6 — Preview resources and navigation](verification/T6-resources-navigation.md) | Done | Local resource and navigation contract verified. |
| [T7 — Preview discovery performance](verification/T7-discovery-performance.md) | Done | 20-site local browser measurements through 1,000 active-site groups; see the report for scope and limitations. |
| [T8 — Stale-reference cleanup](verification/T8-stale-reference-cleanup.md) | In progress | CI wrapper parity and AWS/Cloudflare provider-origin cleanup; local ordering and retry are evidenced. |
| [T13 — Registered admin and satellite flow](verification/T13-registered-flow.md) | Done | Strict registry projection and separate-checkout local workflow verified. |
| [T14 — Production reconciliation and race safety](verification/T14-production-reconciliation.md) | In progress | Local retry, pagination, boundary and invalidation adapter tests are recorded; provider races and real-provider smoke remain open. |
| [T15 — AWS and Cloudflare delivery boundaries](verification/T15-provider-delivery.md) | Open | Real-provider routes, cache, storage isolation and invalidation. |
| [T16 — Clean-room distribution and upgrade](verification/T16-external-adoption.md) | Open | External repositories using pinned released components and rollback. |
