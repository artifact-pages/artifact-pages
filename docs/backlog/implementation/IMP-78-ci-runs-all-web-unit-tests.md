# IMP-78 — CI runs every web unit test script; e2e compose project is configurable

- Status: Done
- Assignee: Codex
- Lanes: CI (primary), Frontend (participating)
- Owner: Codex
- Depends on: —
- Workstream: WS5 CI and test hygiene ([workstreams](../workstreams.md#current-work-packages-2026-10-11))

## Goal

Web unit suites omitted from `.github/workflows/verify.yml` can break unnoticed, and concurrent e2e runs share a hard-coded Compose project name.

## Evidence

- The root `package.json` owns the npm scripts (there is no `web/package.json`). Before this change, `verify.yml` ran a fixed list of scripts and omitted the root `test:reader-shell` suite (`node --experimental-transform-types --no-warnings --test web/src/domain/*.test.mjs`).
- The web unit suites are split across `test:text-highlight`, `test:palette-sections`, `test:reader-shell`, and `test:schema-versions`. The browser-backed `test:fulltext` check remains a separate integration test.
- Before this change, `scripts/run-e2e.mjs` hardcoded `const projectName = 'git-artifact-pages-e2e'`, so parallel runs from different worktrees shared containers.

## Scope

- Run the four current web unit suites in CI through one root `test:web-unit` aggregate so CI has a single entry point for future web unit suites; Claude can extend the aggregate without touching workflows. Keep browser-backed `test:fulltext` in the existing fast-test step.
- Let `scripts/run-e2e.mjs` take the Compose project name from an environment variable (default unchanged), optionally limit each run's Playwright workers, and document it.

## Acceptance criteria

- [x] CI fails when any web unit suite fails (the aggregate is a single workflow step and runs every current web unit suite).
- [x] Two e2e runs with different project names can run side by side locally.

## Local verification

- On source `98035f47`, `npm run test:web-unit` passed all four current suites: text-highlight (17), palette-sections (28), reader-shell (90), and schema-versions (13). `npm run build` also passed.
- Two concurrent e2e runs with `E2E_WORKERS=2` passed all 207 tests each on source `7a4ab987`: `codex-imp-78-retry-a` on port 4175 and `codex-imp-78-retry-b` on port 4176. Each used distinct `web`, `storage`, and `previews` bind mounts under this worktree's `.local/e2e/imp78-a` and `.local/e2e/imp78-b` roots; Compose inspection confirmed their project labels, ports, and mounts while both were running.
- The final-source concurrent pair on `98035f47` used distinct project names and the same separate roots/ports. `codex-imp-78-final-a` passed 208/210; `codex-imp-78-final-b` passed 207/210. The failed tests were existing palette shortcut/dialog, palette IME, and page-text-search iframe-link checks; their error contexts and traces are preserved outside Git at `~/.config/artifact-pages/imp78-evidence-20261012/local-e2e/final/`. Both project-scoped Compose services and networks were removed by their runners. The failures' cause is not established.
- Hosted [CI run 38172000667](https://github.com/artifact-pages/artifact-pages/actions/runs/38172000667) passed all seven jobs on PR head `fef0e10831770af097e53f916cd7d99473a0be67` (attempt 1). The `Web unit tests` step logged text-highlight (17), palette-sections (28), reader-shell (90), and schema-versions (13): 148/148 passed. The browser step reported 210 passed in 1.9 minutes; no retry or flaky-test summary appeared.
- Initial, retry, and final Playwright result bundles and available runner logs, the sanitized hosted-CI summary, and the ignored-worktree inventory are preserved under `~/.config/artifact-pages/imp78-evidence-20261012/`; `SHA256SUMS` verifies the archived files.
