# T4 — Serving routes and cache

- Status: In progress
- Assignee: Codex
- Phase: Phase 1 local analogue; provider serving remains post-MVP

## Contract to prove

Direct preview URLs work without catalog membership; a missing raw file is a real 404 rather than the SPA shell. HTML follows [TD3](../technical-design/TD3-preview-origin-delivery.md): trusted same-origin execution, with iframe CSS/layout containment but no hostile-script isolation. Markdown remains sanitized/non-executable. Provider cache behavior follows the specified freshness and invalidation boundaries. Viewer authentication and authorization are operator-managed edge concerns, not application behavior.

## Exit criteria

- [x] Exercise direct load and reload of a fixed preview URL without catalog membership.
- [x] Verify that missing manifests are hidden in the Previews list and missing raw resources return 404.
- [x] Re-prove that third-party opaque-origin/cross-origin script reads receive no blanket null/wildcard CORS grant while the same-origin preview frame loads local modules and resources under TD3. This is not a privacy guarantee for public static objects.
- [x] Verify iframe CSS containment and intentionally allowed parent-DOM/test-key storage access with benign preview fixtures; verify Markdown script sanitization separately. Former parent-isolation and blanket blocked-fetch assertions are not the accepted HTML contract.
- [ ] Verify browser/CDN cache behavior for mutable catalog responses and removed objects.
- [ ] Verify fixed-name app assets in an already-cached browser during upgrade and rollback, not only origin bytes ([application bundle deployment guide](../../guides/app-bundle-deployment.md)).
- [x] Inject invalidation-only failure for registry registration and app deployment and prove retry convergence at the local/fake boundary ([T22](T22-cache-purge-retry.md), Done). Deployed request/freshness propagation remains in the unchecked provider criteria; the former retry-no-op defect is resolved.
- [ ] Verify provider route and cache behavior for catalog, manifest, HTML/Markdown, local resources, and removed objects. Do not treat customer-managed viewer-access policy as a product feature or completion criterion.

## Evidence

On 2026-09-29, `npm run test:e2e` passed 59/59. The suite verifies the raw same-origin iframe URL, non-loopback-equivalent hostname, transitive modules, relative CSS/image/font resources, validated changed/unchanged navigation, direct reload, CSS containment, intentional parent DOM and test-key localStorage access, HTTPS resources, blocked external HTTP, sanitized Markdown, no-CORS opaque-origin reads, real raw-resource 404s, and a visible failure state for a missing preview document. Malformed preview HTML paths retain a strict CSP. The AWS, Cloudflare/R2, and GCS-emulator edge profile runs each passed their object-storage checks and the same 59/59 browser suite. These are local emulator results only; live provider delivery, cache behavior, and invalidation remain in T15.

The September 27 frame/origin results below are historical evidence for the former sandboxed model. They do not establish the accepted TD3 behavior or live provider support.

On 2026-09-27, the focused Playwright boundary checks passed under the former model: an opaque-origin sandbox on a different local host could not read an HTML preview object, and the isolated local frame loaded relative image and font resources from `preview.localhost`. Those checks confirmed no `Access-Control-Allow-Origin: null` grant at that time; the current raw preview route remains separate from nginx SPA fallback in [`default.conf`](../../../docker/nginx/default.conf).

The provider source/local slice is recorded in [IMP-14](../implementation/IMP-14-provider-serving.md). `npm run test:provider-delivery` checks AWS CloudFront route behavior and Cloudflare Ruleset source for raw preview paths, SPA exclusions, non-cached raw misses, and cache-policy wiring. Local nginx browser tests verify preview catalog, manifest, HTML/Markdown, CSS, script, image, and font response behavior. The Cloudflare MinIO + purge-mock profile verifies local unregister removal and neighbor isolation. None of these exercises a real CDN cache; viewer-access policy, if configured, is customer-managed and outside this product verification.

Local serving is only an analogue. T15 records sampled Cloudflare/AWS freshness/removal and invalidation observations; the complete matrix and propagation bounds remain open. T4 does not test application-level public/restricted site behavior because Artifact Pages has no such policy. An operator who adds an external edge gate verifies that configuration in their own environment. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).

## Implementation links

[IMP-01 records](../implementation/IMP-01-preview-records.md), [IMP-07 local serving](../implementation/IMP-07-local-serving.md), [IMP-08 reader](../implementation/IMP-08-preview-reader.md), [IMP-10 PR return link](../implementation/IMP-10-pr-return-link.md), [IMP-14 provider serving](../implementation/IMP-14-provider-serving.md), [IMP-15 retention](../implementation/IMP-15-provider-retention.md), and [IMP-13 Action](../implementation/IMP-13-action.md) supply the surfaces to verify. Local route tests alone cannot satisfy the provider CDN route, cache, and invalidation proof.

## Reconciled evidence and remaining — 2026-10-18

[T22](T22-cache-purge-retry.md) closes the invalidation retry defect at its stated local/fake boundary. [T15](T15-provider-delivery.md) records Cloudflare October 1–2 canonical warm-URL removal/revalidation and AWS October 14 update (14 s)/unregister (10 s) observations; these are samples, not a global freshness guarantee. The [Cloudflare recovery record](../cloudflare-preview-recovery-proof.md) also proves one enforced runtime HTTP-fetch refusal, superseding the earlier rewritten-fixture limitation for that sample.

Remaining: warm-browser fixed-name app assets across upgrade **and rollback**, full mutable/removed-object cache matrix, deployed invalidation-only failure/retry behavior and the missing route/resource cases on each provider. Use the coordinated plan in [workstreams](../workstreams.md#backend-next-wave-2026-10-18); cloud runs, deployment/rollback and disposable site mutations require a concrete owner approval. Keep In progress.

## Coordinated execution plan

The [October 18 provider-proof plan](provider-proof-plan-2026-10-18.md) owns the remaining shared execution matrix (P3, P7, P8), pinned inputs, commands, preservation/cleanup guards and itemized owner approvals. The [October 20 superseding decision](provider-proof-plan-2026-10-18.md#superseding-execution-decision--october-20-2026) makes Claude main the direct executor with reviewed commands and chat OK under the existing A4–A9 scopes; the harness/signature/registry gates are retired. Hosted OIDC evidence remains required for reference-role claims. Unsupported P4–P7 fault cells stay open/not-run; no criteria close without actual evidence. Recurring P3/P7/P8 coverage is planned in [T28](T28-provider-release-regression.md), separately from the one-off fresh-bucket/bootstrap, natural-expiry timing and migration proofs. This edit records no new provider result.

## Cloudflare A6/A7 recorded evidence — October 24–25, 2026

**Cloudflare local scoped-credential evidence (CLI 0.4.4 darwin_arm64); not hosted Actions/OIDC.** Source: `~/.config/artifact-pages-verify/a6-20261024/evidence/` (`A6-NOTES.md`, `NOTES-A6-part1.md`, `A7-NOTES.md`, `RESTORE-NOTES.md`, `pre/NOTES.md`, `restore/expected-deltas.md`); runbook D1–D11. See the [shared per-cell execution record](provider-proof-plan-2026-10-18.md#cloudflare-a6a7-execution-result--october-2425-2026) and [restoration record](provider-proof-plan-2026-10-18.md#cloudflare-restoration--october-2425-2026). This scoped local run did not exercise Actions v0.2.0 on Cloudflare.

P3 passed sampled a/b/neighbor/preview route/resource delivery, raw misses, control-marker exclusion, headers and edge/origin byte equality; direct unsigned origins returned 400/401. Header checks found no null/foreign CORS grant; opaque-origin browser check timed out and is recorded only. Reserved-name `.txt` octet-stream behavior is separated in [T31](T31-reserved-text-content-type.md). P8 warm 0.3.2 → 0.3.1 → 0.3.2 → 0.3.1 matched each step; P7-app restored 0.3.2 with warm B2/FINAL match. Each app deploy used the owner-approved app-only `--accept-breaking` exception after a no-flag dry-run failed on exactly the six original never-published registrations.

P7-site/registry/app purge-only failures used real HTTP 401 code 10000 from a token without Cache Purge; retries cleared retained records. First recorded canonical poll was fresh after site retry and unregister (six original sites, proof-a index 404). These are sampled observations, not the entire removed-resource matrix or a global bound. P6's out-of-band manifest delete remained edge-cached until its 300 s TTL elapsed. Keep cross-provider exit criteria open. P7 is CLI 0.4.4 evidence only; PR #206 / IMP-82 / T30 remove invalidation and need separate proof.
