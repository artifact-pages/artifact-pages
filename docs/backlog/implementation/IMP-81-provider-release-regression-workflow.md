# IMP-81 — Real-provider release regression workflow

- Status: Open
- Lanes: CLI / release, provider verification
- Depends on: [October 20 provider-proof decision](../verification/provider-proof-plan-2026-10-18.md#superseding-execution-decision--october-20-2026), existing release verification and owner-approved verification environment access
- Verification: [T28](../verification/T28-provider-release-regression.md)
- Source: Owner decisions 2026-10-20; Sol simplified-proof recommendation, section D

## Goal

Add `.github/workflows/provider-regression.yml` with provider-specific jobs and ordinary scripts that exercise obtainable released assets after publication is verified and before operator rollout. Existing release checks do not provide this real-provider regression gate. This is one workflow/integration slice; it does not replace the one-off P1–P10 proof or implement exact released-CLI fault injection.

## Scope

- Trigger after the release workflow verifies published artifacts, plus manual dispatch for an exact immutable CLI/web/Action/module release tuple. Include module releases through the Terraform release lane. Verify hashes, full SHAs and compatibility ranges before execution; failed/missing publication verification cannot start live jobs.
- Use dedicated regression sites/run IDs on Cloudflare `artifact-pages.stream` and the existing AWS verification stack. Obtain explicit future owner authorization for writes, exact policies/credentials, bounds and cleanup; A4 preservation-only permission is insufficient. Serialize shared app/registry work in an exclusive environment window, `cancel-in-progress: false`, coordinated with operator workflows through the same lease.
- AWS uses GitHub OIDC with exact repository/environment subjects, ≤1h sessions and separate admin/satellite roles, no stored AWS keys. Cloudflare uses environment secrets for verify-only issuer/purge credentials and short-lived scoped site children. No production credentials, production requests or routine Terraform apply.
- Implement supported recurring P1 own/neighbor read checks; P2 generated custom-prefix setup and hosted OIDC; P3 routes/resources/headers/origin boundary; P4/P5 native CAS/preview flow, two-site CLI publication and observable interruption/retry; P6 confirmed missing-manifest cleanup; P7 canonical warm update/unregister/invalidation; P8 warm-browser upgrade/rollback/restoration; P9 lifecycle configuration; P10 AWS gzip metadata/decoding, same-URL update/no-op and browser search. Label identity and provider separately.
- Keep unsupported exact P4–P7 fault cells open/not-run and deterministic failure coverage in product tests. Fresh-bucket bootstrap and natural-expiry timing remain one-off, repeated after relevant infrastructure/bootstrap/lifecycle changes. Add gzip migration/old-writer rejection when writer policy changes. A skipped/not-run required recurring case cannot yield a passing gate.
- Baseline unrelated objects/configuration and original app/registry; restrict cleanup to explicit run-owned key/version manifests. Restore app/registrations and compare preservation snapshots even after supported failures/interruption. Upload sanitized evidence and residual-resource/usage reports; keep raw state/control snapshots private.

## Acceptance criteria

- [ ] Workflow/scripts implement the supported matrix above with immutable tuple validation, exact identity selection and meaningful result assertions against actual product commands.
- [ ] Release and Terraform release integration orders verified publication → regression result → rollout eligibility; failed/canceled/incomplete regression withholds rollout. This gate does not gate or authorize publication itself.
- [ ] Local workflow/fixture checks exercise tuple rejection, missing authorization/window, lease conflict, failure/interruption cleanup and evidence sanitization; no provider credentials are needed for these checks.
- [ ] Cleanup/preservation checks fail on unexpected deltas or residue, record exact ownership and stop rather than delete unrelated resources.
- [ ] Independently reviewed workflow, execution/credential/lease instructions and a concrete owner handoff are linked; actual hosted provider results are recorded separately in T28.

Estimate: 4–6 person-days for supported workflow, credential/integration and cleanup work, excluding exact fault injection and waiting for live authorization. Do not claim or implement this item merely because it is listed; claim with Assignee when assigned implementation starts.
