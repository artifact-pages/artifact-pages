# IMP-57 — Shallow-clone publish and preview in the CLI

- Status: Done
- Phase: CLI read side
- Design: [TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md), building on [TD6](../technical-design/TD6-fused-publish-state.md)
- Product contract: the Git metadata and preview selection sections of [the specification](../../specification.md)

Make `site publish` and `preview publish` produce the same metadata and selection from a shallow clone as from a full clone, using the committed per-object hash state, with deepening only when needed.

## Acceptance criteria

- [x] A complete checkout takes the original code path unchanged; existing indexer, preview and publisher suites pass unmodified.
- [x] Production publish from a depth-1 clone carries forward deployed `updatedAt`/`lastCommitter` for documents with an identical attribution scope, deepens only until changed documents resolve to non-boundary commits, and stays shallow when the unchanged documents need no history. Equality with a full clone is asserted per document (`indexer/shallow_test.go`, 10 and 40 commits since the last publish, shared resource change, renamed file, lone deletion, revert within visible history, untracked file fallback).
- [x] No trustworthy prior state (no loader or first publish) unshallows, then matches a full clone.
- [x] End to end: a shallow `PublishSite` against a deployed site yields the same committed input root as a full-clone publish, then a repeat is `no-op`, and the checkout is still shallow. A first publish from a shallow clone unshallows and matches (`publisher/site_publish_shallow_test.go`).
- [x] Preview deepens until the merge-base is exact and matches a full clone's selection, including fetching a missing `origin/main` or head SHA, and ignoring main-only changes (`preview/shallow_test.go`, `gitdepth/gitdepth_test.go`).
- [x] Fetch credentials are scoped, never persisted, and redacted (`gitdepth` `AuthEnv` tests); a failing fetch names `fetch-depth: 0`.
- [x] Dry-run uses the same logic, and the specification records that it may fetch Git history locally but writes nothing to the provider.

## Evidence

2026-10-05, in the `shallow-clone-publish` worktree: `go vet ./...`, `gofmt -l`, `go test ./...` pass; `go test -race` passes for `gitdepth`, `indexer` and `preview`; `node --test scripts/compat-gate.test.mjs scripts/taskfile.test.mjs` passes (16/16). Repository clone times were not measured against a real deep repository. Expected savings are the difference between `fetch-depth: 0` and `fetch-depth: 1` on the caller's repository, plus a small fetch when history is needed.

## Not done here

Action changes: see [IMP-58](IMP-58-actions-shallow-checkout.md). Recording the deployed commit SHA to make content-neutral commits exact is a possible later improvement, though the owner declined a schema change on 2026-10-05 ([TD13](../technical-design/TD13-shallow-clone-publish-and-preview.md#deviations-from-the-first-design-and-judgement-calls)).
