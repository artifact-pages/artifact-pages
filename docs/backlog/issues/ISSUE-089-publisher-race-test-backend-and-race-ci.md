# The publisher legacy-control test backend has a data race and CI never runs `-race`

- Status: Done
- Assignee: Codex
- Priority: P2
- Area: CLI tests / CI
- Implementer: Codex
- Source: public-launch review 2026-10-13, finding R8

## Problem

The test backend in `cli/internal/publisher/site_publish_legacy_control_test.go` records origin writes with an unsynchronized `append`, while the publisher uploads with 8-way parallelism. Under the race detector two publisher tests fail. The ordinary `go test ./...` passes and CI does not run `-race` at all, so a green CI cannot catch this class of problem, and a flaky or misleading test record weakens the other recovery tests that share the backend.

This is a test-only defect. It is not a proven race in a production backend and does not show data loss.

## Evidence and reproduction

1. `sitePublishLegacyCaptureBackend.PutObject` (`cli/internal/publisher/site_publish_legacy_control_test.go:35-38`) runs `backend.originWrites = append(backend.originWrites, key)` with no mutex. The same struct also holds `originDeletes` (line 60), `stateConditions` and `retryConditions` (lines 26-31, in `PutObjectConditional`), `invalidations`, and the one-shot injection flags `raceStateOnPut` / `racedState` (read and set around line 40-41), none of them synchronized.
2. Run `go test -race ./cli/internal/publisher/ -run 'TestPublishSiteRebuildsKnownLegacyPublishStateShapes|TestPublishSiteRebuildsLegacyStateInGetOnlyMode'` on `04783fb3`.
3. Both tests fail with `WARNING: DATA RACE` (public-launch review 2026-10-13, workspace-local report; the full-package `-race` run and the targeted rerun reproduce the same failure). The `cli/internal/preview` and registry packages pass under `-race`.
4. `.github/workflows/verify.yml` runs `go vet ./...` (line 56) and `go test ./... -count=1` (line 66); no workflow passes `-race`.

## Expected outcome

The test backend is safe for the publisher's concurrent uploads, and CI fails when a race appears in the publisher, preview or registry packages.

## Acceptance criteria

- [x] Every recorded field of the test backend (`originWrites`, `originDeletes`, `stateConditions`, `retryConditions`, `invalidations`) and the one-shot race-injection state (`raceStateOnPut`, `racedState`) are accessed under a mutex, and tests read them through accessors or after the publish has finished.
- [x] `go test -race` passes for `cli/internal/publisher`, `cli/internal/preview` and the registry package.
- [x] A CI job runs `go test -race` for those packages and fails the workflow on a race.
- [x] The tests still assert the same outcomes (no origin or state writes before a backup conflict, the injected concurrent writer is observed exactly once).

## Verification

- `go test -race -count=3 ./cli/internal/publisher/... ./cli/internal/preview/... ./cli/internal/registry/...` — passed.
- `go test ./... -count=1` — passed.
- `go vet ./...` — passed.
- `gofmt -l $(git ls-files '*.go')` — clean.
