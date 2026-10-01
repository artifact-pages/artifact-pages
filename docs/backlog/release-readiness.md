# Cloudflare-first release execution

Checked on October 1, 2026 (JST). This is an execution order and handoff map, not a second specification or ticket queue. Linked tickets own their acceptance criteria and status. Public demo deployment is already live; general release/adoption readiness is not yet proven. AWS is independently gated, and GCP remains emulator-only.

| Order | Outcome required | Existing records | Current evidence / next action |
| --- | --- | --- | --- |
| 1 | Close the Cloudflare delivery gap | [T15](verification/T15-provider-delivery.md) | Notice-route repair was applied and both notice files match packaged text. Live API inspection confirmed the active R2 custom domain, disabled managed domain and deployed route/cache/CSP rules. Retain control-to-SPA fallback without WAF. Sampled delivery proof is recorded; do not infer comprehensive credential/isolation proof. |
| 2 | Prove publishing, preview and recovery against R2 | [T4](verification/T4-serving-boundary.md), [T5](verification/T5-concurrency-recovery.md), [T8](verification/T8-stale-reference-cleanup.md), [T14](verification/T14-production-reconciliation.md), [T15](verification/T15-provider-delivery.md) | Approved `release-smoke` production/preview publication, resources, native Markdown/Mermaid, same-head no-op retries, live R2 CAS/publication-flow tests, simulated missing-manifest pruning and unregister/cache withdrawal passed; test content was removed and Guide hashes preserved. Remaining: lifecycle deletion timing, delegated credentials, competing new-group CLI/recovery tests and HTTP-blocking proof (edge rewrote the negative fixture to HTTPS). Missing-site preview-list presentation is also recorded in T15. |
| 3 | Prepare independently pinned distribution candidates | [TD2](technical-design/TD2-component-release-policy.md), [IMP-38](implementation/IMP-38-terraform-registry-publication.md) | Select a clean reviewed source SHA for CLI/Actions and a separately versioned web bundle with checksum/manifest/notices. The deployed `cloudflare-not-found-20261001-01` archive is a smoke label built with unrelated uncommitted documentation changes, not an official release. Validate the self-contained Cloudflare module and isolated consumer. Do not add standalone CLI binary distribution merely to unblock documentation. |
| 4 | Publish the module and candidate artifacts with approval | [IMP-38](implementation/IMP-38-terraform-registry-publication.md), [T16](verification/T16-external-adoption.md) | Confirm candidate versions and approve exact source pushes/tags/GitHub assets. Connect GitHub to Terraform Registry and verify retrieval at the real published address/version. Candidate publication enables adoption testing; it does not declare general readiness. |
| 5 | Complete clean-consumer and upgrade/rollback proof | [T16](verification/T16-external-adoption.md), [T4](verification/T4-serving-boundary.md), [T6](verification/T6-resources-navigation.md) | Separate admin/satellite repos consume pinned artifacts without OSS source copying. Register, deploy, publish and optionally use the thin Action; upgrade/rollback the web app in a warm browser while keeping site data unchanged. Reconcile the completed local T6 regressions against its remaining scope rather than rerun historical repairs as new work. |
| 6 | Finish the minimum adoption documentation and declare scope | [Documentation queue](documentation/README.md), [release order](README.md#first-public-release-order) | Getting started, publishing, config and access/trust must describe the tested obtainable versions and real commands. Pages retain their owner review gate. Architecture expansion and unrelated product polish need not hold the initial Cloudflare release. State exact supported versions and evidence; do not advertise AWS support based only on local tests. |

## Work that can advance without another routine decision

- Local module repair, regression tests, package validation and independent review.
- Reusable non-mutating delivery checks and preparation of an isolated provider smoke procedure.
- Candidate manifests/checksums, source-pin consistency and clean-consumer test preparation.
- Backlog evidence reconciliation and release-independent documentation work within its existing review assignments.

## Narrow owner handoffs

- Infrastructure credentials with read/plan capability and approval of the actual notice-route plan/apply. CLI purge credentials are not assumed to authorize ruleset inspection or mutation.
- Approval of the disposable site ID/source and its register/publish/preview/unregister lifecycle before public test data or deletions are introduced.
- Exact first release versions, source pushes/tags and Registry account connection/publication. No release is implicit in a request to deploy the existing public app.
- Review of reader-facing documentation drafts already governed by the documentation queue.

At each handoff, continue other local preparation and report the exact prepared artifact and next action. Do not mark the parent verification tickets Done from a subset of live HTTP checks.
