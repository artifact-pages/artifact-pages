# IMP-54 — Action-owned checkout (`checkout`, `fetch-depth`)

- Status: Done
- Lanes: Actions
- Execution: Agent-led. A run on a GitHub-hosted runner is not part of this slice; [IMP-47](IMP-47-actions-hosted-smoke.md) covers hosted execution and uses its own checkout (`auto` skips).
- Depends on: [IMP-34](IMP-34-actions.md), [IMP-13](IMP-13-action.md)
- Related design: [TD8](../technical-design/TD8-action-consumer-contract.md)

## Goal

Consumers no longer need an `actions/checkout` step. The Action checks out when the workspace is not a Git checkout and leaves an existing checkout alone.

## Acceptance criteria

- [x] `checkout` (`auto` default, `true`, `false`) and `fetch-depth` (default `0`) exist on the root, site-publish, admin and preview Actions; invalid values fail (`actions/shared/checkout-mode.test.mjs`).
- [x] `auto` detects a Git work-tree root and skips; a plain directory, a missing directory and a subdirectory of a repository count as not a checkout (same test).
- [x] The checkout is pinned to a full SHA with a version comment, uses the workflow token, sets `persist-credentials: false`, and precedes Go setup (`scripts/test-actions-parity.mjs`).
- [x] The preview Action checks out the base ref, never the pull-request head, and the checkout precedes the trust preflight (parity test; ordering recorded in TD8).
- [x] Specification "Shared Action behavior" and the preview paragraph no longer say the Action never fetches. `npm run test:actions-shared` and `npm run test:actions-parity` pass.

## Not done

- The shallow-repository check was deliberately left out. Shallow-clone support is handled separately.
- Hosted-runner behavior of the new steps is unverified until IMP-47's smoke is extended or a consumer runs it.
