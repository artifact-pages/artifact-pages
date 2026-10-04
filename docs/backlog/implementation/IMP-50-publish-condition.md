# IMP-50 — Publish condition for site and admin Actions

- Status: Done
- Lanes: Actions
- Execution: Agent-led.
- Depends on: [IMP-34](IMP-34-actions.md)
- Related design: [TD8](../technical-design/TD8-action-consumer-contract.md)

## Goal

A caller declares when a real publish happens (for example "real publish on push to main, dry-run otherwise") with one input instead of hand-written `dry-run:` expressions.

## Acceptance criteria

- [x] `publish-on` exists on the root, `actions/site-publish` and `actions/admin` Actions; empty preserves current behavior (matcher tests, parity input contract).
- [x] A non-matching run becomes a dry-run that changes no storage and logs a notice; explicit `dry-run: true` always wins; malformed entries fail (`actions/shared/publish-on.test.mjs`, `scripts/test-actions-parity.mjs`).
- [x] The preview Action is deliberately unchanged (see TD8).
- [x] Specification "Shared Action behavior" documents the input. `npm run test:actions-shared` and `npm run test:actions-parity` pass.
