# `registry sync --dry-run` reports "unchanged" while planning to create the registry

- Status: Done
- Priority: P3
- Area: CLI registry sync
- Assignee: Codex

## Problem

The text output of a dry-run says the registry projection is unchanged when the plan creates it. An operator reading only the text output would conclude that applying does nothing.

## Evidence and reproduction

1. Empty verification bucket (`artifact-pages-verify`, 2026-10-03), config `artifact-pages.verify.yaml`.
2. `artifact-pages registry register --config artifact-pages.verify.yaml --dry-run`
3. Text output: `↻ invalidate /_indexes/sites.json`, then `Registry projection: unchanged.`. The JSON output of the same run is correct: `outcome: planned`, `registryUpdated: false`, with `create _indexes/sites.json` and `create _indexes/sites.json#sites/smoke`.

Cause: the text renderer derived "unchanged" from `registryUpdated`, which is `false` for every dry-run.

## Expected outcome

A dry-run says that the registry would be created or updated whenever the plan contains registry changes, and "unchanged" only when it does not.

## Acceptance criteria

- [x] The dry-run text distinguishes "would create/update" from "unchanged", based on the planned changes.
- [x] A regression test covers dry-runs for an empty target, a changed target and an unchanged target.

## Resolution

The text report now derives dry-run wording from a planned change on the root `_indexes/sites.json` projection: `create` reports "would create", `update` reports "would update", and no root change reports "unchanged". Real runs retain the existing `RegistryUpdated` wording.

Verified with `cd cli && go test ./... -count=1` and `go vet ./...`. `TestRunRegistryRegisterReadsSelectedConfigAndDryRunDoesNotCreateStorage` covers an absent projection, a changed projection and an unchanged projection through the CLI text renderer.
