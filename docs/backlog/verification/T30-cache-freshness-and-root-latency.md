# T30 — No-invalidation freshness and shared-root latency

- Status: Open
- Phase: Provider-backed deployments / reusable distribution
- Scope: D-LT delivery correctness and the 5-or-0-second shared-root decision; Cloudflare R2 first, AWS separately gated
- Depends on: [IMP-82 Phase 1](../implementation/IMP-82-cli-owned-cache-policy.md), explicit owner unfreeze/run approval and bounded verification access
- Source: Owner decisions 2026-10-24 recorded in [IMP-82](../implementation/IMP-82-cli-owned-cache-policy.md): the measurement plan was narrowed for the long-tail workload to the shared roots, and the result changes only the fixed CLI policy

## Contract to prove

With invalidation removed, CLI-authored Cache-Control and origin-respecting delivery provide the accepted freshness without regressing document rendering/compression. Measure whether 5 seconds of shared freshness for sites/meta/index produces useful reader latency savings over 0. The policy is fixed in the CLI; experiments do not introduce operator overrides. Search manifest, artifacts/resources and previews stay at 0; hashed search blobs/app assets stay one-year immutable.

This is separate from implementation because it needs an authorized live window and measured evidence. Use [T29](T29-compressed-reader-session-hosting-cost.md)'s compressed session vectors as a baseline, not as evidence of real CDN hit rates. Feed class-specific origin rates and latency/cost findings into [T27](T27-launch-hosting-cost-model.md) without closing its unmeasured preview/registry/app-deploy scope. No broad artifact fresh-hit benchmark or content-addressed-storage implementation benchmark is needed.

## Trimmed measurement plan

1. Record approved targets, exclusive window, run-owned objects, cleanup/restoration, CLI/module/source versions, region/browser/tool versions, pricing date and time/request/spend bounds. `artifact-pages.stream` remains frozen until the owner explicitly unfreezes it. Use available aggregate data or a bounded 48–72-hour sample for URL-class/site frequency and edge distribution; disclose missing natural-traffic data and any replay assumptions. Keep bodies, shared assets and search classes separate.
2. Compare roots at 0 and 5 seconds using natural arrivals or replayed recorded arrival times. In Japan, North America and Europe, target about 50 samples per root/state: sites/meta/index fresh hit (5 seconds), expired unchanged and changed. Observe manifest at its fixed 0 as a control. Save status, TTFB, body/total time, bytes, Age, cache status and validators. Do not infer normal hit rates from artificial bursts. Use normal URLs, without cache-busting queries or DevTools cache disable.
3. Per region, target about 20 cold opens, three-page SPA sessions, normal reloads and searches, including a large index and representative HTML. Measure until body display/search results; do not add one RTT per request as a proxy. Record mean/p95, dispersion and reproducibility for the paired 0/5 comparison.
4. Smoke-test representative Markdown and HTML with CSS, images, modules and JSON fetch. Check TTL-0 compression, decoded bytes/rendering, validators and resource waterfalls; measure a shared resource's hot-path impact only if observed. Check one-year immutable and private `no-store` behavior separately.
5. For about 10 warm-update cycles, record origin commit and visible convergence for update, create/delete/re-create (including a prior 404), preview group/revision access, registry omission, app update/remove and old search-blob 404 recovery. Exclude freshness polling from hit-rate statistics. Check negative caching, stale/error behavior, Cloudflare OCC and conflicting rules. Verify browser revalidation while keeping already-open reader/in-memory state limits explicit.
6. Distinguish browser→edge from edge→origin validation. A browser 304 alone does not establish an origin 304; mark edge→R2 304 behavior UNVERIFIED if it cannot be observed. TTL 0 need not yield a 304. Verify zero purge calls for all affected commands and reduced credentials, plus migration of old headers/previews and expiry of old edge entries.

Sample counts are planning targets within the approved budget. Record actual counts, timing and deviations; insufficient data must not be presented as a conclusive latency result.

## Run brief (prepared in IMP-82 Phase 1)

What exists locally, merged on monorepo `main` (#207, #209, #211, #214, #215, #216 and the slice 7 PR):

- **CLI:** fixed class headers (`cli/internal/publisher/cache_policy.go`, spec cache table), no invalidation in any command, legacy journal migration. A run uses a CLI built from a recorded `main` commit or the first release that contains it; record which.
- **Modules:** the AWS origin-respecting policy (`0/0/31536000`, `no_store` only for `/_errors/*`, no `CreateInvalidation`) and the unchanged Cloudflare `respect_origin` rule. Both are validated locally only.
- **Preview helper:** `go run ./cli/tools/migrate-preview-cache --config PATH --site ID [--apply]`.
- **Runbook:** [cache policy migration](../../guides/cache-policy-migration.md), with the migration order, verification, credential retirement and rollback.
- **Local evidence:** edge profiles (`node scripts/run-edge-profile.mjs cloudflare|aws|gcp`) show legacy-header seeds passed through once, zero purge requests and converged headers. Their Playwright stage has known unrelated `web/e2e/local-serving.spec.ts` failures.

Order on `artifact-pages.stream`, after the owner's unfreeze and run approval:

1. Record the approved scope (plan step 1) and back up the run-owned control records.
2. Rehearse the runbook on the stream deployment, steps 1–7: compatible CLI for every writer, module apply (Cloudflare: expect no cache-rule change), `registry sync` / `site sync --reconcile` / `app deploy`, the preview helper, a 300-second wait, then header and edge checks. Record each step's output; this run is also the runbook's first exercise.
3. Run the measurement plan (steps 2–6 above) at the approved root value of 5 seconds. For the 0-second comparison, build a CLI whose policy revision sets the root classes to 0. It is used only on the stream deployment and is never released or used as an operator setting. Converge the headers with `registry sync` / `site sync --reconcile`, wait out the 5-second roots, then measure. Return to the approved policy afterwards and record the convergence.
4. Rehearse the runbook rollback on the stream deployment, or record why it was deferred.
5. Restore the stream deployment to the agreed final state and record residue cleanup.

Record the credential scope used: explicit R2 pair without an API token, or single-token without Cache Purge. Also record the zero-purge observation per command. AWS stays out of this run unless separately approved.

## TTL decision rule

- Start with the approved 5 seconds for sites/meta/index; consider each root class separately. All changes go into the CLI policy, its revision and specification/tests, with header convergence and old-TTL expiry as in IMP-82.
- Choose 0 if estimated hit rate is below 5% and there is no meaningful end-to-end improvement.
- Retain 5 when, compared with 0, a relevant reader operation reproducibly improves by at least 20 ms in the mean or 100 ms at p95 within the accepted freshness budget. Report whether that operation represents the observed workload; fewer origin requests alone do not justify freshness delay.
- For inconclusive, conflicting or underpowered results, record uncertainty and obtain the owner's final 5-or-0 choice; do not silently invent a threshold outcome or claim an unmeasured benefit.
- The earlier r3 15/60-second candidates are outside the approved 5-or-0 decision. Any extension requires a new owner decision showing the latency gain and additional stale-display budget, not a runtime override.

## Exit criteria

- [ ] Link sanitized raw measurements and a reproducible report covering the plan, actual counts/conditions, assumptions, per-class distributions, 0/5 latency comparison and owner-approved final root policy. Leave missing cells explicitly unverified.
- [ ] Establish Cloudflare delivery correctness for TTL 0/5/immutable, compression/validators/negative caching/resources, no-invalidation convergence and reduced credentials. Link migration/header-expiry results and preserved unrelated state; local tests alone do not pass these cells.
- [ ] Record AWS separately if authorized: fresh plan/recreation, origin-respecting `min/default/max=0/0/31536000`, TTL-0 compression/conditional fetch/negative cache, and no invalidation permission. If not authorized, label AWS not run/unverified and link the owner's deferral and rollout restriction; stream results cannot prove CloudFront behavior.
- [ ] Link the class-based cost follow-up through IMP-82 / T27 using T29's baseline, distinguishing measured origin rates from assumptions and preserving excluded operations. Report bytes/compression changes that could affect transfer costs.
- [ ] Independently review results and link the final decision to IMP-82 Phase 2. Completion requires actual Cloudflare evidence and a recorded disposition for AWS; preparation, scripts or environment availability alone are insufficient.

## Owner boundaries and evidence

No new run, credential access, environment mutation, paid load or production action is authorized by this item. AWS resources were destroyed; recreation needs a new plan and explicit approval. The owner approves unfreeze, exact live scope/budget, final root TTL and any release/production migration/credential retirement under IMP-82. Evidence: none yet.
