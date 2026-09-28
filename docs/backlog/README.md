# Backlog

This is the entry point for work that is not yet complete. Keep product defects, unresolved technical designs, implementation slices, and unverified contracts distinct: they have different definitions of `Done`.

| Track | Purpose | Open | In progress | Blocked | Done |
| --- | --- | ---: | ---: | ---: | ---: |
| [Issues](issues/README.md) | Independently actionable product problems with evidence and acceptance criteria. | 14 | 0 | 0 | 0 |
| Technical design | Decisions about how to fulfill an accepted contract. | 0 | 0 | 0 | 10 |
| [Implementation](implementation/README.md) | Independently reviewable slices for preview, registry, normal publish, providers, local contract tests and distribution. | 3 | 0 | 0 | 36 |
| Verification | Tests or measurements needed to prove an accepted contract. | 3 | 4 | 0 | 2 |

There are 14 active issues: 13 review defects and the separate site-description improvement remain open. There are no open technical designs and seven unfinished verification items. ISSUE-014's local source/output boundary, ISSUE-015's preview-key codec, ISSUE-016's AWS web-bundle delivery, ISSUE-017's site-discovery failure isolation, ISSUE-018's empty-site reconciliation, ISSUE-019's fixed-name app asset caching, ISSUE-021's lock-CAS wait bound, ISSUE-022's same-head retry after a default-branch advance, ISSUE-023's static JavaScript module dependency parsing, and ISSUE-024's inline HTML module dependency collection were verified and removed from the active queue. The [review repair queue](issues/README.md#repair-order) now continues with P2 repairs; TD3 is settled and ISSUE-026 is now an Open repair, not a design blocker. T6 is reopened for newly exposed resource/navigation gaps. Implementation completion checkpoints do not imply release readiness. Viewer access is an operator-managed edge concern, not a product-level site policy. Provider adapters and reference infrastructure are implemented locally, but no linked provider delivery or external clean-room verification is claimed complete. The [specification](../specification.md) owns accepted behavior; the [preview decision register](../architecture/preview-decisions.md) records preview decisions; the [publishing contract](../architecture/preview-publishing-contract.html) records its provider-neutral shape and proof boundary. Backlog files track unfinished work and its evidence, not a second specification.

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

## Delegation

Use the [delegation and collaboration index](delegation.md) to distinguish work that an agent can carry through locally from work that needs an owner decision, account access, or publication approval. Execution mode is separate from status and priority; collaborative work can still have agent-led preparation.

| Mode | Current work | Owner handoff |
| --- | --- | --- |
| `Agent-led` | Priority-ordered review repairs including ISSUE-026; settled local T6 regressions; IMP-37/39 provider-module preparation when assigned. | Escalate only a new model/UX/trust decision or authority boundary; verify and independently review before committing. |
| `Collaborative` | The separate ISSUE-013 improvement, remaining provider/CI proof, IMP-38 Registry publication, and T16 external adoption. | Specific decisions or authorized external actions, with local evidence and prepared artifacts first. |

See the linked index for the exact preparation/handoff boundary and Cloudflare-first adoption sequence. A backlog entry does not start an implementation or authorize cloud/public operations.

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
| [TD2 — Component licensing and release version boundaries](technical-design/TD2-component-release-policy.md) | Done | Establish first-party MIT licensing, web dependency notices, and per-deliverable version/ref boundaries. |
| [TD3 — Trusted same-origin preview rendering](technical-design/TD3-preview-origin-delivery.md) | Done | Owner accepted the production-equivalent HTML trust model; reader/profile implementation and local/live proof remain ISSUE-026 and T4/T6/T15. |

## Implementation

The [implementation index](implementation/README.md) lists 39 scoped tickets with dependencies and acceptance criteria: 36 historical local completion checkpoints and three new Open infrastructure/distribution slices. IMP-01–18 cover preview; IMP-19–35 cover the other accepted product surfaces; IMP-36 establishes the local storage/edge contract test foundation. [IMP-37](implementation/IMP-37-cloudflare-entry-module.md) adds the Cloudflare entry module including bucket creation; [IMP-38](implementation/IMP-38-terraform-registry-publication.md) tracks provider-module Registry publication and clean-consumer retrieval. [IMP-39](implementation/IMP-39-aws-cloudflare-dns-acm.md) adds the selected AWS custom-domain composition with Cloudflare DNS and ACM. Backlog status does not expand the current Phase 1 boundary by itself.

The owner selected the [public domain and delivery policy](../architecture/deployment-domain-policy.html): long-lived `artifact-pages.dev` on Cloudflare Cache/CDN + R2, with Cloudflare Registrar/DNS; `aws.artifact-pages.dev` exercises CloudFront/private S3 through DNS-only Cloudflare records and ACM in `us-east-1`, without Route 53. The owner confirmed domain purchase on September 28, 2026; account/zone inputs, credentials, authoritative DNS/TLS, approved apply, and T15/T16 delivery evidence remain unfinished. A future GCP hostname does not add a supported adapter.

## Remaining workstreams

The original implementation slices have recorded local completion checkpoints. The 2026-09-28 review found 24 follow-up defects; their [issue queue](issues/README.md) now owns repairs, rather than duplicate IMP tickets. Design and verification files own unresolved contracts and broader proof. Do not read the historical Done entries as a bug-free or release-ready claim.

| Workstream | Current state | Remaining outcome |
| --- | --- | --- |
| Review repairs and reader parity | Thirteen review defects remain in the active issue queue; ISSUE-014–024 have been fixed and verified with committed regressions. | Work [one issue at a time in priority order](issues/README.md#repair-order), implement the settled TD3 contract in ISSUE-026, and re-prove T6. |
| Component release and adoption | CLI, app bundle, and optional Actions are implemented locally ([IMP-31](implementation/IMP-31-app-distribution.md), [IMP-34](implementation/IMP-34-actions.md)); the release contract is recorded in [TD2](technical-design/TD2-component-release-policy.md), while [T16](verification/T16-external-adoption.md) remains open. | Verify clean-repository adoption with a web-app SemVer plus immutable Action/CLI and Terraform source refs, including upgrade and rollback. If standalone CLI binaries become a release artifact, include Go dependency notices with them. |
| GitHub Actions | Thin admin and explicit-site composite Actions plus caller-owned workflow templates exist. No reusable workflow is required or provided. | Publish a reviewed immutable Action ref and verify hosted/released-component use as part of T16. Adopters retain control of triggers, approvals, and credential policy. |
| Provider infrastructure | AWS and Cloudflare reference infrastructure sources are implemented ([IMP-30](implementation/IMP-30-aws-deployment-module.md), [IMP-33](implementation/IMP-33-cloudflare-deployment.md)); live delivery evidence remains in [T15](verification/T15-provider-delivery.md). | Validate real-provider routes, cache behavior, access isolation, OIDC scopes, and invalidation. GCP currently has a local emulator profile only; a production GCP adapter/module is not in the current supported-provider scope. |
| Terraform entry point and Registry distribution | Current Cloudflare delivery/retention modules require an existing R2 bucket; no public Registry module is claimed. [IMP-37](implementation/IMP-37-cloudflare-entry-module.md) and [IMP-38](implementation/IMP-38-terraform-registry-publication.md) are Open. | Prepare a single entry module locally, prove Cloudflare delivery with the owner in T15, then authorize Registry publication and verify exact-version retrieval. Module SemVer belongs to its provider-specific release, not the web-app tag. IMP-39 adds the AWS Cloudflare DNS/ACM path independently; it does not delay the first Cloudflare release. |
| Publish reliability and cleanup | Local implementation exists; review exposed convergence, retry and wait-bound defects. | Finish provider and failure-recovery evidence in [T4](verification/T4-serving-boundary.md), [T5](verification/T5-concurrency-recovery.md), [T8](verification/T8-stale-reference-cleanup.md), and [T14](verification/T14-production-reconciliation.md). |

## First public release order

This is the recommended gate order for a usable public release. The linked backlog items remain the source of status and acceptance criteria; this sequence does not duplicate them.

1. **Release contract — [TD2](technical-design/TD2-component-release-policy.md) (Done).** The first-party MIT scope, web-bundle notices, web-only `vMAJOR.MINOR.PATCH`, immutable source refs for Actions/CLI and Terraform, schema compatibility boundary, and rollback expectations are recorded.
2. **Repair review-confirmed defects — [issue queue](issues/README.md#repair-order), [TD3](technical-design/TD3-preview-origin-delivery.md), and [T6](verification/T6-resources-navigation.md).** ISSUE-014 through ISSUE-020 are closed with committed regressions. Continue the ordered P2 repairs. TD3 is Done and ISSUE-026 is unblocked under the accepted same-origin HTML contract; continue the ordered repairs. Resolve each remaining review defect or record an explicit approved deferral and impact before declaring readiness. Site-description feature work is separate.
3. **Prepare the adoption entry point and complete supported-provider proof — [IMP-37](implementation/IMP-37-cloudflare-entry-module.md), [T4](verification/T4-serving-boundary.md), [T5](verification/T5-concurrency-recovery.md), [T8](verification/T8-stale-reference-cleanup.md), [T14](verification/T14-production-reconciliation.md), and [T15](verification/T15-provider-delivery.md).** Implement and validate the Cloudflare entry module locally before its real-account adoption run. Prepare [IMP-39](implementation/IMP-39-aws-cloudflare-dns-acm.md) for the AWS hostname independently; its proof is not a dependency of the first Cloudflare release. Start live validation with Cloudflare; close provider and recovery evidence for every provider eventually advertised as supported. AWS evidence stays distinct, and `gcp-local` remains emulator-only. No cloud account or credentials are assumed to exist.
4. **Prepare and authorize independent distribution releases — [IMP-38](implementation/IMP-38-terraform-registry-publication.md).** Produce the web-only `vX.Y.Z` release candidate and matching archive, manifest, and checksum from the policy-approved commit. Record the reviewed Action SHA independently. Prepare the Terraform package in parallel, but publish the initial Cloudflare Registry module only after its provider proof and explicit owner authorization; record its own exact module version and source commits. Update TD2 and consumer guides for that Registry path before claiming released-module adoption. AWS publication has its own readiness gate and must not block Cloudflare's module. Ensure setup guides retain the HTML/Markdown trust model and upgrade/rollback instructions. No public release is claimed by local packaging.
5. **Verify the candidate in clean consumer repositories — [T16](verification/T16-external-adoption.md).** Use the published component pins from separate admin and satellite repositories; include exact-version Registry module retrieval after IMP-38. Verify complete-manifest registry register dry-run/apply, site dry-run/publish, app deployment, optional Action parity, and app upgrade/rollback without changing site content. Repeat the claimed supported-provider workflows; Cloudflare is the first live adoption target, while AWS and broader delivery proof remain separate. Do not call the supported workflow generally ready until those proofs pass.
6. **Declare the supported distribution and publish the web-app release.** Do this only after the review repair gate, TD2/TD3, the selected providers' proof, T6, and T16 pass. State the supported Action SHA, Terraform source refs, web-app version, and schema contracts; keep GCP out of the support statement unless a production adapter and its evidence are separately added.

The P2 [site-description issue](issues/ISSUE-013-site-description.md) is product polish, not a release gate under the current roadmap.

## Verification

| Item | Status | Evidence needed |
| --- | --- | --- |
| [T4 — Serving routes and cache](verification/T4-serving-boundary.md) | In progress | Provider route, cache, and invalidation proof; viewer access is operator-managed. |
| [T5 — Concurrency and recovery](verification/T5-concurrency-recovery.md) | In progress | Cross-process locks, concurrent updates, and injected-failure tests. |
| [T6 — Preview resources and navigation](verification/T6-resources-navigation.md) | Open | Reopened after review: encoded paths, modules/raw-HTML images, resource links, fragments and provider-style reader parity. |
| [T7 — Preview discovery performance](verification/T7-discovery-performance.md) | Done | 20-site local browser measurements through 1,000 active-site groups; see the report for scope and limitations. |
| [T8 — Stale-reference cleanup](verification/T8-stale-reference-cleanup.md) | In progress | CI wrapper parity and AWS/Cloudflare provider-origin cleanup; local ordering and retry are evidenced. |
| [T13 — Registered admin and satellite flow](verification/T13-registered-flow.md) | Done | Strict registry projection and separate-checkout local workflow verified. |
| [T14 — Production reconciliation and race safety](verification/T14-production-reconciliation.md) | In progress | Local retry, pagination, boundary and invalidation adapter tests are recorded; provider races and real-provider smoke remain open. |
| [T15 — AWS and Cloudflare delivery boundaries](verification/T15-provider-delivery.md) | Open | Real-provider routes, cache, storage isolation and invalidation. |
| [T16 — Clean-room distribution and upgrade](verification/T16-external-adoption.md) | Open | External repositories using pinned released components and rollback. |
