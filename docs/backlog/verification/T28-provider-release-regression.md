# T28 — Real-provider release regression evidence

- Status: Open
- Phase: Provider-backed deployments / reusable distribution
- Scope: recurring release workflow behavior, real-provider results and preserved verification environments
- Depends on: [IMP-81](../implementation/IMP-81-provider-release-regression-workflow.md), explicit future owner authorization and exclusive verification windows
- Source: Owner decisions 2026-10-20; [superseding provider-proof decision](provider-proof-plan-2026-10-18.md#superseding-execution-decision--october-20-2026)

## Contract to prove

`provider-regression.yml` tests verified published assets on dedicated regression sites in the existing AWS and Cloudflare verification stacks, reports supported recurring coverage honestly, restores unrelated state, and gates operator rollout. Implementation completion alone does not establish these results. This ticket verifies one recurring workflow contract; the original one-off criteria remain in T4/T5/T8/T14/T15 and IMP-73.

## Exit criteria

- [ ] Record owner authorization, exact targets/sites/run IDs, immutable release tuple/checksums/ranges, workflow/source SHA, tool/runner/browser versions, credential identity/policy scope, exclusive lease/window and time/usage/spend limits for each live run. No production secrets/requests or routine Terraform apply; AWS ≤1h exact-subject OIDC admin/satellite sessions and Cloudflare verify-only scoped children; no purge credential or CloudFront invalidation permission (IMP-82).
- [ ] Show a verified publication triggers the matching regression before rollout, and manual dispatch tests the same exact tuple. Include Terraform module-release integration. Failed/unverified publication cannot start live regression; failed/canceled/incomplete regression withholds rollout.
- [ ] Record P1 own-site success plus confirmed-existing neighbor denial on both providers; P2 AWS generated custom-prefix role/runtime OIDC; both providers’ P3 route/resource/MIME/cache/CSP/origin/control boundary; supported P4/P5 native CAS, real preview/two-site CLI and observable interruption/retry; P6 missing-manifest cleanup with neighbor preservation; P7 canonical warm-URL update/unregister converging within the CLI header bounds with zero purge/invalidation requests; P8 warm-browser upgrade/rollback/restoration; P9 lifecycle configuration readback. Record AWS P10 raw stored-gzip metadata/decoding, same-URL update/no-op and browser search.
- [ ] Record per-provider/case pass/fail/not-run with command, identity class, request IDs, origin/edge/browser timestamps and assertion evidence. Exact P4–P7 injected fault cells without a supported live mechanism remain open/not-run; deterministic tests or approximate interruption timing cannot pass them. Failure/retry coverage requires a demonstrated supported mechanism.
- [ ] Demonstrate shared-window serialization with operator workflows and `cancel-in-progress: false`; overlapping attempts cannot mutate shared app/registry concurrently.
- [ ] Demonstrate normal completion and a supported failure/interruption path: resolve recorded transactions, clean only run-owned keys/versions, restore original registrations/app and compare complete unrelated object/configuration baselines. Report and fail on residue, unknown writers or unexpected drift; do not mask these with broad deletion.
- [ ] Link sanitized hosted run/evidence and usage/residue reports for both providers. Raw state/control snapshots remain private; retained artifacts contain no credentials or authorization headers. Independently review the evidence and link recurring results to the relevant original tickets without closing their unproven cells.

Fresh-bucket bootstrap remains a one-off proof (natural-expiry observation was dropped on 2026-10-20; P9 not pursued, not passed) and is repeated after relevant changes, not on every release. Writer-policy changes require a migration/old-writer rejection lane; routine gzip smoke does not establish migration. Changes to infrastructure/bootstrap or lifecycle policies require their corresponding one-off rerun before rollout. Existing A1–A9 caps authorize no future regression run; obtain that future authorization separately.

## Evidence

None yet. No workflow run, environment mutation or new provider proof is claimed by creating this item.

Future expectations follow the no-invalidation contract of [IMP-82](../implementation/IMP-82-cli-owned-cache-policy.md). Earlier purge evidence, including [T22](T22-cache-purge-retry.md) and the Cloudflare A6/A7 P7 cells recorded on CLI 0.4.4, stays as history of the old contract and is not a current requirement.
