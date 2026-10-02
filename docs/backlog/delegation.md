# Backlog delegation and collaboration

[Release execution order](release-readiness.md) · [Component lanes and dependencies](workstreams.md) · [Issue repair order](issues/README.md#repair-order) · [Implementation index](implementation/README.md)

Execution mode answers **how work can be delegated**, not its priority or completion status. Keep the existing tracks and directories; do not create a second backlog sorted by assignee. This index records the current modes and handoffs. Each ticket remains the source of truth for status, dependencies, acceptance criteria, and evidence.

## Modes

| Mode | Agent responsibility | Owner involvement |
| --- | --- | --- |
| `Agent-led` | Work within an accepted contract: investigate, implement locally, test, obtain independent review, and commit the verified concern when assigned. | No routine implementation-detail approvals. Escalate a newly exposed product/data-model/UX/trust decision or new authority. |
| `Collaborative` | Prepare evidence, alternatives, local code/tests or release artifacts up to a concrete handoff. Continue independent preparation instead of treating the whole item as blocked. | Make the identified product/setup decision, select accounts/domains, supply credentials outside Git, authorize external changes, or perform interactive publication steps. |

`Collaborative` is not a synonym for `Blocked`. Mark an item Blocked only when no meaningful in-scope progress remains without the recorded decision or external change. Neither mode grants cloud, public-release, or later-phase implementation authority; the assigned scope and repository guidance still apply.

## Current agent-led queue

| Work | Delegation scope | Completion / handoff |
| --- | --- | --- |
| [T17 — Local preview retirement E2E](verification/T17-local-preview-retirement-e2e.md) | When assigned, connect actual CLI publication, local object deletion, main-source reconciliation and warm-browser withdrawal in the existing local test path. | Record repeatable local results and independent review. No cloud account, real expiry wait or product expiry mechanism; do not treat the local proof as T15 completion. |
| [Review repair queue](issues/README.md#repair-order), beginning with ISSUE-027 | Follow its current priority/order one issue at a time. Reproduce, add a regression, verify, and obtain independent review under the accepted contracts. | Commit each verified concern; update/remove completed issue records under the issue policy. Do not wait for unrelated cloud access. |
| [T6 — Resources and navigation](verification/T6-resources-navigation.md) | The ISSUE-026 same-origin rendering and intentional parent-access checks passed in the local and emulator profiles; continue with remaining resource/navigation issues. | Record actual local evidence; provider behavior remains T15. TD3 is a completed decision, not a remaining blocker. |
| [IMP-37 — Cloudflare entry module](implementation/IMP-37-cloudflare-entry-module.md) | When assigned, implement the single entry module, local validation, and caller example. | Local acceptance closes IMP-37; hand a tested config and fresh-plan checklist to T15 for an explicitly authorized real-account run. |
| [IMP-39 — AWS Cloudflare DNS/ACM composition](implementation/IMP-39-aws-cloudflare-dns-acm.md) | In the Terraform workflow, add the selected custom-domain path after AWS source packaging; preserve the caller-managed DNS/certificate path and test locally. | Independent review/local acceptance may close the implementation; DNS/TLS/direct CloudFront proof stays T15. Do not delay the first Cloudflare release. |

Completed improvements remain historical evidence and are not reopened merely to assign an execution mode.

## Current collaborative work

| Work | Agent can prepare now within assigned scope | Owner handoff |
| --- | --- | --- |
| [T4](verification/T4-serving-boundary.md), [T5](verification/T5-concurrency-recovery.md), [T8](verification/T8-stale-reference-cleanup.md), [T14](verification/T14-production-reconciliation.md) | Prepare deterministic tests, failure fixtures, remaining-proof checklists, and a safe provider smoke procedure. | Authorize and participate in the remaining real-provider/CI runs; local results do not close provider proof. |
| [T15 — Provider delivery](verification/T15-provider-delivery.md) | Prepare an isolated caller, plan instructions, permissions/cost checklist, and route/cache/storage smoke tests. Start with Cloudflare; keep AWS evidence distinct. | Select account/zone/hostname, arrange credentials, review a real plan, and authorize apply, smoke, and cleanup. Record any provider-plan limitations instead of assuming compatibility. |
| [IMP-38 — Registry publication](implementation/IMP-38-terraform-registry-publication.md) | Prepare module source migration, packaging, candidate version, provenance, validation, and consumer examples in the two existing provider repositories. | Confirm the release version; authorize pushes/tag publication and connect Registry to GitHub. Repository names are already owner-selected. |
| [T16 — External adoption](verification/T16-external-adoption.md) | Prepare clean-consumer scripts, pin checks, and upgrade/rollback tests. | Select/authorize real consumer repositories and released components, plus the required provider runs. Registry publication and app release are separate approvals. |

These groups cover the current unfinished tracks without copying fast-changing issue statuses here. A newly discovered decision moves only the affected slice to collaboration; unrelated agent-led work continues.

The owner selected the [public domain and provider delivery policy](../architecture/deployment-domain-policy.html) and confirmed purchase of `artifact-pages.dev` on September 28, 2026. Retain it under the Cloudflare Registrar/DNS policy; use the apex for Cloudflare Cache/CDN + R2 production and `aws.artifact-pages.dev` for direct CloudFront/S3 verification via DNS-only records. Domain acquisition is recorded; account/zone identifiers, credentials, authoritative DNS/TLS proof, plan approval, and external actions remain explicit owner handoffs. No Route 53 hosted zone or production GCP implementation follows from this policy.

## Delegation and handoff protocol

1. Assign a queue or named ticket explicitly. The agent follows the linked repair/release order and the ticket's dependencies; listing an item here does not start its implementation.
2. For agent-led work, report the verified outcome and commit. Ask only when the accepted model/UX/trust boundary or authority would change.
3. For collaborative work, report **what is prepared, what specifically needs the owner, and what happens next**. Include evidence and a recommended choice or exact plan/action; avoid a vague request to “set up the cloud.” Group related decisions into one handoff.
4. Keep preparation and external proof separate. Record progress and the remaining handoff in the ticket; do not mark it Done merely because the agent has reached its boundary.
5. Obtain an independent review before closing implementation/repair work. For shared-checkout work, preserve concurrent changes and commit only the assigned concern.

## Cloudflare adoption sequence

Use the [Cloudflare-first release execution map](release-readiness.md) for the current ordered gates and narrow owner handoffs. It links the existing tracks rather than introducing a second set of tickets.

Current review repairs continue independently. The next adoption path is IMP-37 local preparation → T15 Cloudflare plan/apply and delivery proof → IMP-38 authorized Registry publication → T16 clean-consumer adoption. IMP-38 package preparation can run alongside IMP-37/T15, but its public release waits for the advertised provider's proof. Web-app packaging/release, site registration, and site-content publication retain their own existing gates; publishing a Terraform module does not deploy the application or publish documentation automatically.
