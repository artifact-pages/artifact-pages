# IMP-60 — Restore the Go cache and build the CLI once per job

- Status: Done
- Lanes: Actions
- Depends on: [IMP-46](IMP-46-action-marketplace-release.md) (slice 3, the Go build cache), [IMP-56](IMP-56-prebuilt-cli-binaries.md)
- Found: 2026-10-06, while measuring the IMP-46 build cache

Track choice: a defect in the Action wiring with a known fix direction, so it is an implementation slice. Its proof is in the acceptance criteria below.

## Problem

On the source-build path (SHA or branch pins, and this repository's `Composite Actions smoke`), every Action in a job runs `setup-go`, restores the Go caches and runs `go build`. From the second Action on, the restore targets an already populated `GOMODCACHE`/`GOCACHE`: `tar` reports `Cannot open: File exists` for thousands of files, `actions/cache` warns `Failed to restore`, and the step costs 2-4 s. In a ten-Action job the nine redundant restores cost more than the build they save, and `setup-go` plus `go build` repeat for nothing.

## Design

`actions/shared/build-once.mjs` has two commands.

- `plan` runs after the released-binary step. It sets `build=false` when the released binary is installed, or when `$RUNNER_TEMP/artifact-pages` exists and `$RUNNER_TEMP/artifact-pages.build-marker` records the same source hash and the same binary digest. Otherwise `build=true`.
- `record` runs after `go build` and writes the marker.

The source hash covers `go.mod`, `go.sum` and every file under `cli/` of the Action's own source tree, so Actions pinned to different revisions in one job do not share a binary. The binary digest makes a released binary installed over a source build invalidate the marker.

In all four `action.yml` files (root, `actions/site-publish`, `actions/admin`, `actions/preview-publish`), `setup-go`, the cache key step, `actions/cache` and `go build` run only when `steps.build-plan.outputs.build == 'true'`. The prebuilt-binary step is unchanged. Because the later Actions skip `actions/cache`, its post step is skipped there too, so the cache is saved once, by the first Action.

## Acceptance criteria

- [x] `actions/shared/build-once.test.mjs` covers first build, reuse, changed source, changed binary, corrupt marker and the released-binary path (`npm run test:actions-shared`).
- [x] `scripts/test-actions-parity.mjs` asserts the plan step, the four guarded steps, one cache step and the marker record in every Action, and passes.
- [x] In the `Composite Actions smoke` job, only the first Action runs `setup-go`, the cache restore and `go build`; no `tar: File exists` is logged; the post step saves the cache once. Timings before and after are recorded below.
- [x] The released-binary path is unchanged.

## Evidence

`Composite Actions smoke`, 10 Action invocations, step times summed from the job logs (cache key hit in all three runs):

| Run | Job | `setup-go` | cache step | `go build` | `tar: File exists` / `Failed to restore` |
| --- | --- | --- | --- | --- | --- |
| Before: [37329984151](https://github.com/tasuku43/git-artifact-pages/actions/runs/37329984151) | 59 s | 10.2 s (x10) | 15.9 s (x10) | 4.8 s (x10) | 34,740 lines / 9 |
| Before: [37329758840](https://github.com/tasuku43/git-artifact-pages/actions/runs/37329758840) | 79 s | 9.9 s (x10) | 30.4 s (x10) | 4.8 s (x10) | 34,740 lines / 9 |
| After: [37331040685](https://github.com/tasuku43/git-artifact-pages/actions/runs/37331040685) | 39 s | 8.6 s (x1) | 2.8 s (x1) | 2.1 s (x1) | 0 / 0 |

The nine later Actions each log `skipping (reusing the CLI built earlier in this job from the same source)` and spend about 0.1 s in the plan step. The cache hit in the after run means its post step had nothing to save; with a miss the first Action's post step is the only one that exists, because the later `actions/cache` steps never run.

## Progress

- 2026-10-06: implemented. Baseline: run [37329984151](https://github.com/tasuku43/git-artifact-pages/actions/runs/37329984151) (warm cache) job 59 s, `setup-go` 10.2 s, cache steps 15.9 s, `go build` 4.8 s (all summed over 10 Actions), 9 `Failed to restore` warnings; run [37329758840](https://github.com/tasuku43/git-artifact-pages/actions/runs/37329758840) job 79 s, cache steps 30.4 s, same warnings.
