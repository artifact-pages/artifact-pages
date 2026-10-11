# IMP-78 — CI runs every web unit test script; e2e compose project is configurable

- Status: Open
- Lanes: CI (primary), Frontend (participating)
- Owner: Codex
- Depends on: —
- Workstream: WS5 CI and test hygiene ([workstreams](../workstreams.md#current-work-packages-2026-10-11))

## Goal

Web unit tests that exist in `web/package.json` but are not run by `.github/workflows/verify.yml` can break unnoticed, and two sessions cannot run the e2e suite at the same time.

## Evidence

- `verify.yml` runs a fixed list of root `package.json` scripts and does not include `test:reader-shell` (`node --test web/src/domain/*.test.mjs`: directory, document-language, match-navigator, nearby-pages, preview-time, scroll-edges, search-facets, search-ranking, search-route, site-folder-counts). Those suites have only run locally.
- `scripts/run-e2e.mjs` hardcodes `const projectName = 'git-artifact-pages-e2e'`, so parallel runs from different worktrees share containers.

## Scope

- Run every web unit test script in CI. Add `test:reader-shell`, and prefer one aggregate script in the root `package.json` (for example `test:web-unit`) so a new suite cannot be forgotten; Claude can add new suites to that aggregate without touching workflows.
- Let `scripts/run-e2e.mjs` take the compose project name from an environment variable (default unchanged) and document it.

## Acceptance criteria

- [ ] CI fails when any web unit suite fails (prove with a deliberately failing commit in a draft PR, or by listing the executed suites in the job log).
- [ ] Two e2e runs with different project names can run side by side locally.
