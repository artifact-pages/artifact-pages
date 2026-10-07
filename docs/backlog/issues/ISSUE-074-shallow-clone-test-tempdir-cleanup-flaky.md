# TestBuildFromGitShallowCloneSelectsLikeFullClone fails intermittently on TempDir cleanup

- Status: Done
- Priority: P3
- Area: Go tests that run `git fetch` (`cli/internal/preview`, `cli/internal/gitdepth`)

## Problem

`go test ./...` in CI failed once with the three subtests of `TestBuildFromGitShallowCloneSelectsLikeFullClone` reporting `TempDir RemoveAll cleanup: unlinkat .../shallow/.git/objects/pack: directory not empty`. The assertions themselves passed; the failure is the cleanup. The rerun passed.

## Evidence and reproduction

- Failed run: https://github.com/artifact-pages/artifact-pages/actions/runs/37604157938 (first attempt, job "Verify / Unit, type and browser tests", PR #41, which only changed web code). The rerun passed.
- Confirmed: every `git fetch` ends with `git maintenance run --auto --detach` (`GIT_TRACE` shows it). When the repository crosses the auto-gc threshold, that process daemonizes and rewrites `.git/objects` after `git fetch` has returned. In a scratch repository with ~900 loose objects and `gc.auto=1`, `objects/pack` went from 3 to 4 to 6 entries and loose objects dropped from 897 to 0 after the fetch had exited. A directory being written while `t.TempDir` removes it produces exactly the reported error.
- Not confirmed: the test itself never failed locally. 300 runs at default settings, and about 85 runs with `gc.auto=1` (with and without `fetch.unpackLimit` variations), all passed. The fixture is small, so it is unclear which condition made gc run on the CI runner. The link between this mechanism and the CI failure is therefore likely, not proven.

## Expected outcome

Tests that run git are deterministic: no git background process outlives the command that started it.

## Fix

- `cli/internal/gittestenv.Apply` (called from a `TestMain` in the five packages whose tests run git) adds `gc.auto=0`, `gc.autoDetach=false`, `maintenance.auto=false` and `fetch.writeCommitGraph=false` through `GIT_CONFIG_COUNT`/`KEY`/`VALUE`, so it also reaches git run by the code under test.
- Production: the deepening fetch in `cli/internal/gitdepth` passes `-c gc.auto=0 -c maintenance.auto=false`. In a CI checkout a detached gc after a deepening fetch is wasted work and can still be running when the job cleans up. The change only affects that one fetch invocation and no repository configuration.

## Acceptance criteria

- [x] The `TestMain` environment and the fetch flags are in place.
- [x] `go vet ./...` and `go test ./... -count=1` pass.
- [x] The shallow test passes 40 of 40 runs with `gc.auto=1` forced in the outer environment (the fixed environment overrides it).
