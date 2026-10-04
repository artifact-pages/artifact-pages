# IMP-51 — Built-in Job Summary for every Action

- Status: Done
- Lanes: Actions
- Execution: Agent-led.
- Depends on: [IMP-34](IMP-34-actions.md), [IMP-13](IMP-13-action.md)
- Related design: [TD8](../technical-design/TD8-action-consumer-contract.md)

## Goal

Consumers stop writing "Summarize" steps. The Action writes an operation-specific, documented summary itself, including on failure.

## Acceptance criteria

- [x] Root, site-publish, admin and preview Actions have a `summary` input (default `true`); `false` writes nothing (`actions/shared/summary.test.mjs`, parity test).
- [x] Site publish, registry register/unregister, app deploy and preview each render the contracted content; failures render the error; documents and change lists are capped (`summary.test.mjs`).
- [x] The summary is written after the outputs, also for failed CLI runs and failed preview preflight, and never changes outputs or exit codes (`scripts/test-actions-parity.mjs`).
- [x] The format is documented in the specification ("Shared Action behavior"). `npm run test:actions-shared` and `npm run test:actions-parity` pass.
