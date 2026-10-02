# Cloudflare-first release proof reconciliation

Checked on October 2, 2026 (JST). This reconciles existing evidence for [T15](verification/T15-provider-delivery.md), [IMP-38](implementation/IMP-38-terraform-registry-publication.md) and [T16](verification/T16-external-adoption.md). It neither changes the accepted contract nor declares a release ready. T15 spans providers; its unchecked parent criteria cannot be read as a list of entirely untested Cloudflare features. Ticket files remain the status source of truth.

## Owner-selected execution boundary

On October 2 the owner selected completing the remaining live Cloudflare verification **before publication**, and authorized continuing narrowly scoped disposable verification and fixing discovered defects. Candidate `208abf5` / module-only `0.1.0` remains on hold; no push, tag, Registry publication or cloud infrastructure/security-policy change is authorized here. Preserve Guide, other registrations and the retained natural-lifecycle experiment. Infrastructure changes or tests requiring another identity/network must stop at an explicit handoff.

If a defect changes source, select a new clean candidate SHA, independently review the repair and repeat affected checks before release selection. No release tag exists yet; create it only after final approval. Never move or replace an already published tag or its assets: a correction after publication requires a new version. CLI/Action and module selections remain independent.

## Evidence already established, with limits

| Outcome | Existing evidence | Limit on the claim |
| --- | --- | --- |
| DNS/TLS and intended origin | T15 live DNS/TLS observations plus read-only configuration inspection: active R2 custom domain and disabled managed `r2.dev` domain | Sampled current deployment, not proof for a new consumer or every alternate endpoint |
| Logical/raw routes, resources and metadata | T15 Guide and disposable production/preview requests and browser observations; raw missing objects returned real 404s | Route/resource samples, not every encoded path or browser behavior |
| Cache and update/withdrawal | Actual response headers, canonical publish/unregister requests, warm-browser observations in T15 | No universal global propagation bound; an already-open document need not disappear without revalidation |
| Notice delivery | Actual LICENSE and dependency-notice bytes matched the deployed smoke package | Smoke app, not a published official web version |
| Private control plane | Sampled actual coordination-key requests returned the SPA shell, not private bytes | HTTP 200 shell is allowed; do not report an explicit edge 403 or exhaustive bypass protection |
| Delegated R2 publication | [Scoped reader/writer proof](cloudflare-scoped-credentials-proof.md): native denials, real CLI production/preview publication, same-head no-op and cleanup | No hosted OIDC, complete process-wide least privilege, separate purge-token isolation or prevention of deleting the writer's retained preview history |
| Conditional writes and preview completion | T15 real R2 CAS race and publication-flow tests | Two competing ETag writers are not two competing new-head CLI publications; sequential second-group retention is not interrupted-publication recovery |
| Distinct-head CLI concurrency and recovery | [October 2 live recovery proof](cloudflare-preview-recovery-proof.md): concurrent new heads, partial-upload SIGKILL/recover/retry, stale-owner rejection after lock recovery, complete four-head catalog and exact cleanup/preservation passed | Named scenarios at CLI source `f1ed001`, not all failure points or providers |
| Runtime HTTP fetch refusal | Same live proof: Chromium on raw Guide received an enforced CSP violation for a runtime-constructed insecure fetch, avoiding HTML rewrite ambiguity | This request/page/browser only, not all resource types or packet-level network absence |
| Retirement reconciliation | [T17](verification/T17-local-preview-retirement-e2e.md) local real-CLI/object-API/nginx/browser proof and [live simulated deletion](cloudflare-preview-lifecycle-proof.md) | Local proof and simulated origin deletion are not natural R2 lifecycle evidence |
| Module packaging and provenance | [IMP-38 local preparation](cloudflare-module-publication-preparation.md): clean authoritative candidate `208abf5eb6a7323e6161b7a798ba401dcf149c9f`, matching the reviewed snapshot tree, rerun exact-SHA package/consumer checks and independent review | Candidate version 0.1.0 is proposed, not approved or published; local Git retrieval is not Registry retrieval |

Historical T15 paragraphs describe the evidence available at their observation dates. Later explicit evidence supersedes those limitations only for the named samples, not for all providers or a whole parent criterion.

## Remaining Cloudflare proof and next safe step

| Gap | Next step | Authority / completion boundary |
| --- | --- | --- |
| Natural lifecycle removal | Continue the already-approved read-only seven-object observation; after confirmed absence, follow its authorized main-publish/cleanup procedure | Do not rewrite the revision, shorten retention or infer deletion from eligibility. Record last-present/first-absent interval. Catalog may also expire; absent catalog permits a no-op, not a fabricated prune. |
| Concurrency/recovery scope reconciliation | Compare intended release guarantees against the completed named distinct-head and partial-upload/lost-owner scenarios in the live recovery proof | These sampled gaps now have live evidence. Do not infer every failure-point guarantee or repeat public mutations without a specific additional need. |
| HTTP refusal scope reconciliation | Use the completed runtime-fetch CSP proof for its exact policy/page/browser boundary; identify an additional resource-specific test only if an advertised guarantee requires it | A rewritten HTTPS source or WAF 403 remains distinct from CSP refusal. Existing Guide and policy bytes were unchanged. |
| Optional WAF enforcement | Read-only active rule plus existing-egress HTTPS/443=200, HTTP/80=403 and HTTPS/8443=403 are recorded in the live recovery proof. Complete nonallowlisted-IP and required attribution/rollout proof with an approved external vantage or owner evidence | Existing token lacks analytics permission for rule attribution. No authorized alternate egress was available. Do not mint credentials, edit allowlists or disable security implicitly; rollout/rollback remains untested. |
| Module publication approval and retrieval | Owner reviews clean candidate `208abf5eb6a7323e6161b7a798ba401dcf149c9f`, proposed module-only 0.1.0 and advertised evidence; after explicit external approval, publish and verify actual Registry retrieval | Local source integration, clean full-SHA validation and independent review are complete. No tag/push/description change/Registry publication follows implicitly; T15/T16 proof limits remain. |

Preparatory procedures should identify exact object namespaces, heads, commands, expected observations, preservation guards, failure/rollback points and cleanup before requesting live authority. Do not introduce application expiry, PR-state cleanup, extra mandatory workflows or a broad new test service.

## Claims that require a separate scope decision or proof

- **AWS support:** live AWS DNS/ACM/CloudFront/S3 and IAM/first-use checks remain independent. IMP-44 is not a Cloudflare release dependency; do not remove AWS criteria from T15 merely to close the Cloudflare branch.
- **Hosted identity / retained-history restrictions:** the current R2 scoped read/write result does not satisfy T15's stronger GitHub OIDC and retained-history-delete claims. Record provider-specific limitations explicitly. Advertising those guarantees needs proof or an owner-approved change to advertised scope; this reconciliation does not waive accepted requirements.
- **GCP production:** remains emulator-only; local JSON API/nginx proof does not establish production support.
- **Official app/module/Action adoption:** smoke deployment and local snapshots are not published components. Exact final source/version approval, source/tag/assets publication and Registry connection/retrieval remain explicit external steps. T16 closes only after the real obtainable selections are consumed and tested.
- **Optional policy coverage:** publishing an optional WAF interface does not prove every caller expression, action, plan entitlement or policy protects the intended content. Describe tested configurations and operator responsibility; do not advertise universal enforcement.

## Convergence and handoff

Source integration and local proof preparation run in parallel with natural-deletion observation. Before requesting publication, provide: the clean authoritative module SHA, independently selected CLI/Action SHA and web version if included, exact completed evidence, named unproved claims, a recommended initial scope, and the precise proposed external actions. Scope exclusions affecting accepted behavior require owner agreement rather than silently labeling missing proof optional.

After approval and publication, use an isolated caller to retrieve the actual Registry version and released app/Action selections, then hand evidence to T16. Reader-facing adoption pages remain Claude-owned and should consume confirmed facts only; do not rewrite those pages from this internal reconciliation.
