# IMP-61 — Per-Action repositories, thin Actions and release sync

- Status: Done
- Lanes: Actions, CLI / release
- Depends on: [TD14](../technical-design/TD14-one-repository-per-action.md), [IMP-45](IMP-45-unified-release-and-compatibility.md), [IMP-56](IMP-56-prebuilt-cli-binaries.md)
- Proves: [T2](../technical-design/T2-cli-action-interface.md) parity, still green

## Goal

Implement [TD14](../technical-design/TD14-one-repository-per-action.md): four Actions with one operation each, published from their own repositories as thin wrappers over the released CLI.

## Acceptance criteria

- [x] `actions/publish`, `actions/preview`, `actions/registry`, `actions/app-deploy` with typed inputs and outputs per operation and no `operation` input; the root `action.yml` and `actions/admin|site-publish|preview-publish` are removed.
- [x] The Actions install the CLI from `release.json` with checksum verification and fail otherwise; no source build, Go cache or build-once logic.
- [x] Unreleased source runs only with `ARTIFACT_PAGES_TEST_CLI`; a published Action ignores it. Unit tested.
- [x] `scripts/build-action-repos.mjs` generates the repositories deterministically; `scripts/sync-action-repos.sh` publishes and tags idempotently and never moves a tag. Tested against local bare repositories.
- [x] `release.yml` syncs after `verify-published` with the release GitHub App token.
- [x] CI smoke runs the four Actions by local path with a CLI built in the job; `registry unregister` is exercised with the CLI.
- [x] Parity script, shared tests, examples and docs updated.

## Results

- 2026-10-06: implemented in the PR that moves the product to the `artifact-pages` organization. The first live sync happens when `v0.1.0` is tagged; see [release readiness](../release-readiness.md).
- 2026-10-06: live cut-over complete: `v0.1.0` tagged and synced to the four Action repositories, consumers re-pinned, and the registry, publish and app-deploy (dry-run) runs used the `v0.1.0` CLI binary. See [release readiness](../release-readiness.md#organization-v010-cut-over-2026-10-06).
