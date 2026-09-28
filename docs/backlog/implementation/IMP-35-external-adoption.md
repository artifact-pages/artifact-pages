# IMP-35 — External-repository adoption and release readiness

- Status: Done
- Phase: Reusable distribution
- Depends on: [IMP-28](IMP-28-local-operator-flow.md), [IMP-30](IMP-30-aws-deployment-module.md), [IMP-31](IMP-31-app-distribution.md), [IMP-34](IMP-34-actions.md)
- Proves: adopter-owned workflow guidance and a reproducible local clean-room flow

## Outcome

Provide adopter-facing examples and a reproducible local walkthrough that use independent admin and satellite repositories without copying the application source into either repository. Proving adoption of publicly released components and provider accounts is a separate verification task.

## Acceptance criteria

- The clean-room walkthrough covers config selection, complete-manifest registration, app deploy, explicit site publish, update and unregister against the local object target, using independent admin and satellite repositories that do not contain the application source.
- Document adopter roles, the Git/HTML trust model, bundle checksum verification, per-deliverable version/ref selection, upgrade/rollback, and failure recovery.
- Keep public released-component adoption in [T16](../verification/T16-external-adoption.md), provider delivery in [T15](../verification/T15-provider-delivery.md), and Cloudflare deployment parity in [IMP-33](IMP-33-cloudflare-deployment.md). The policy is recorded in [TD2](../technical-design/TD2-component-release-policy.md); this local implementation does not claim a public release or released-component proof.

## Local clean-room evidence

`scripts/test-clean-room-adoption.mjs` creates independent temporary admin and satellite Git repositories and a local object target under ignored `.local/` storage. It verifies explicit config selection, registration of the complete site manifest, separate-site publish/update/unregister, dry-run immutability, app archive checksum rejection, app deploy/upgrade/rollback without changing site objects, guarded stale-lock recovery, and neighboring-site preservation. It invokes the local Action/CLI parity check at the end. `docs/guides/clean-room-adoption.md` records adopter roles, the trust boundary, per-deliverable immutable refs, and recovery steps. Reverified in the current audit: `node scripts/test-clean-room-adoption.mjs` passed, and `go test -race -count=1 -run '^TestDeployAppDownloadsPublishedVersionOverHTTPS$' ./internal/publisher` passed against a local HTTPS test server. The clean-room app archives are generated fixtures, not releases; these checks do not prove AWS behavior, released component pins, or cross-revision adoption. Those remain open in T15 and T16.
