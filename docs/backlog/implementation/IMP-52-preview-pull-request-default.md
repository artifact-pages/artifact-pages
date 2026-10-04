# IMP-52 — Preview `pull-request` defaults from the pull_request event

- Status: Done
- Lanes: Actions
- Execution: Agent-led.
- Depends on: [IMP-13](IMP-13-action.md), [IMP-10](IMP-10-pr-return-link.md)
- Related design: [TD8](../technical-design/TD8-action-consumer-contract.md)

## Goal

On a `pull_request` event a caller no longer writes `pull-request: ${{ github.event.pull_request.number }}`, and `comment: true` works without it. The CLI stays explicit-only.

## Acceptance criteria

- [x] Empty `pull-request` resolves to the event's number only on `pull_request`; `push`, `workflow_dispatch`, `pull_request_target` and others give a manual preview; an explicit value wins; `none` forces manual; a payload without a valid number is an error (`actions/shared/preview-refs.test.mjs`).
- [x] The defaulted number goes through the same trust verification as an explicit one, including fork and head-SHA rejection (`scripts/test-actions-parity.mjs`).
- [x] `comment: true` works on `pull_request` without an explicit input and stays quiet for `none` and other events (`actions/shared/preview-comment.test.mjs`).
- [x] The CLI is unchanged. Specification §19 and the GitHub Actions guide are updated. `npm run test:actions-shared` and `npm run test:actions-parity` pass.
