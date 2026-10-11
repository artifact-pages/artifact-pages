# IMP-78 — CI runs every web unit test script; e2e compose project is configurable

- Status: In progress
- Assignee: Codex
- Lanes: CI (primary), Frontend (participating)
- Owner: Codex
- Depends on: —
- Workstream: WS5 CI and test hygiene ([workstreams](../workstreams.md#current-work-packages-2026-10-11))

## Goal

Web unit suites omitted from `.github/workflows/verify.yml` can break unnoticed, and concurrent e2e runs share a hard-coded Compose project name.

## Evidence

- The root `package.json` owns the npm scripts (there is no `web/package.json`). `verify.yml` runs a fixed list of scripts but omits the root `test:reader-shell` suite (`node --experimental-transform-types --no-warnings --test web/src/domain/*.test.mjs`), which has only run locally.
- The web unit suites are split across `test:text-highlight`, `test:palette-sections`, `test:reader-shell`, and `test:schema-versions`. The browser-backed `test:fulltext` check remains a separate integration test.
- `scripts/run-e2e.mjs` hardcodes `const projectName = 'git-artifact-pages-e2e'`, so parallel runs from different worktrees share containers.

## Scope

- Run the four current web unit suites in CI through one root `test:web-unit` aggregate so CI has a single entry point for future web unit suites; Claude can extend the aggregate without touching workflows. Keep browser-backed `test:fulltext` in the existing fast-test step.
- Let `scripts/run-e2e.mjs` take the Compose project name from an environment variable (default unchanged), optionally limit each run's Playwright workers, and document it.

## Acceptance criteria

- [ ] CI fails when any web unit suite fails (prove with a deliberately failing commit in a draft PR, or by listing the executed suites in the job log).
- [x] Two e2e runs with different project names can run side by side locally.

## Local verification

- On rebased source `98035f47`, `npm run test:web-unit` passed all four current suites: text-highlight (17), palette-sections (28), reader-shell (90), and schema-versions (13). `npm run build` also passed.
- Two concurrent e2e runs with `E2E_WORKERS=2` passed all 207 tests each on source `7a4ab987`: `codex-imp-78-retry-a` on port 4175 and `codex-imp-78-retry-b` on port 4176. Each used distinct `web`, `storage`, and `previews` bind mounts under this worktree's `.local/e2e/imp78-a` and `.local/e2e/imp78-b` roots; Compose inspection confirmed their project labels, ports, and mounts while both were running.
- The final-source concurrent pair on `98035f47` used distinct project names and the same separate roots/ports. `codex-imp-78-final-a` passed 208/210; `codex-imp-78-final-b` passed 207/210. The failed tests were existing palette shortcut/dialog, palette IME, and page-text-search iframe-link checks; Playwright error contexts and traces remain under ignored `test-results/codex-imp-78-final-{a,b}`. Both project-scoped Compose services and networks were removed by their runners. The failures' cause is not established.
- The hosted verify job has not yet run with this change; keep the item In progress until its log shows the aggregate web-unit step executing.
