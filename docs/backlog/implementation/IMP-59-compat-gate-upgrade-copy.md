# IMP-59 — Compatibility gate upgrade check loses HTTP metadata

- Status: Open
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
- Re-enable the gate's upgrade check for the `0.x` to `1.0` path as TD2 requires.

## Acceptance criteria

- [ ] A regression test or fixture fails with the current copy and passes with the fix.
- [ ] The root cause is recorded here with the reproduction result, whichever way it comes out.
- [ ] The gate runs the upgrade check against a real baseline tag and a candidate with a schema-1 state, and the candidate CLI converges without the HTTP metadata error.
- [ ] `node --test scripts/compat-gate.test.mjs` passes.
