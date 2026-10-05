# IMP-59 — Compatibility gate upgrade check loses HTTP metadata

- Status: Done
- Lanes: CLI / release
- Depends on: [IMP-45](IMP-45-unified-release-and-compatibility.md)
- Must be done before: the first `1.0.0` release (the gate is skipped for `0.x`, see [TD2](../technical-design/TD2-component-release-policy.md))
- Found: 2026-10-05, while preparing v0.2.0

Track choice: this is a defect in release tooling code with a known fix direction, so it is an implementation slice. The proof that the repaired gate works lands in this item's acceptance criteria; it needs no separate verification ticket.

## Problem

`scripts/compat-gate.mjs` (around line 831) prepares the upgrade check with `cpSync(storages[upgradeSourceName], storages['storage-upgrade'], { recursive: true })`. The local directory backend keeps HTTP metadata (content type, cache control, ETag inputs and the `artifact-pages-*` user metadata) outside the storage root, in the sibling directory `root + ".metadata"` (`cli/internal/publisher/local_backend.go`, `storedObjectMetadataPath`). The copy therefore carries objects without their metadata.

The likely consequence is the candidate CLI failing the upgrade check with `site publish state HEAD has unexpected HTTP metadata` (`cli/internal/publisher/site_publish_state.go`), because the copied private state object has no content type or cache control. The root cause is not confirmed: it has not been reproduced with a controlled run, and another cause of that error is not excluded.

## Work

- Reproduce the failure with an upgrade-check run from a baseline that publishes a schema-1 state, with the gate's `0.x` skip bypassed locally.
- Confirm or refute the sibling-metadata cause (for example by copying `root + ".metadata"` and comparing outcomes).
- Fix the copy so the upgrade storage carries both the objects and their metadata. Prefer a helper that copies a backend's complete state over assuming its layout in the script; also review the other `cpSync` (around line 899) for the same assumption.
- Re-enable the gate's upgrade check for the `0.x` to `1.0` path as TD2 requires. (The check was never removed: the `0.x` skip is decided from the candidate version, so a `1.0.0` candidate runs it. The skip stays as the owner decided.)

## Acceptance criteria

- [x] A regression test or fixture fails with the current copy and passes with the fix.
- [x] The root cause is recorded here with the reproduction result, whichever way it comes out.
- [x] The gate runs the upgrade check against a real baseline tag and a candidate with a schema-1 state, and the candidate CLI converges without the HTTP metadata error.
- [x] `node --test scripts/compat-gate.test.mjs` passes.

## Evidence (2026-10-05)

Reproduction: the candidate was a copy of the tree with `Product = "1.0.0"` so the `0.x` skip did not apply, run with `--baseline v0.1.2 --baseline-version 0.1.2 --tag v1.0.0` (and again with `v0.1.0`). A `v0.2.0` baseline gives a `compatible` verdict, so the upgrade step does not run for it; the control-breaking path needs a baseline without schema-1 publish state.

- Before the fix, both baselines failed `candidate CLI upgrades legacy baseline storage` with `site publish notes -> storage-upgrade (candidate CLI) failed with 1: error: validate site publish state HEAD: site publish state HEAD has unexpected HTTP metadata`.
- Root cause confirmed: the `cpSync` of the storage root left `<root>.metadata` behind, so the copied private state object had no content type or cache control.
- After the fix (`copyStorage` copies the root and its `.metadata` sibling as one unit), both runs exit 0 with verdict `breaking`, result `passed`, and `candidate CLI upgrades legacy baseline storage` passed, plus both web reads of the upgraded storage.
- The other `cpSync` (the web archive and its `.json`/`.sha256` files) copies plain files and has no sibling state. Mutex files live under `<root>/_control`, inside the root.
- Regression tests: `copyStorage` tests in `scripts/compat-gate.test.mjs` (`node --test scripts/compat-gate.test.mjs`: 14 passed).
