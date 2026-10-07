# IMP-72 — First releases under TD17 and operator rollout

- Status: Open
- Lanes: CLI / release, Operator repositories
- Owner: Codex (owner approval for each release and production step)
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md), IMP-68, IMP-69, IMP-70, IMP-71
- Blocks: —

## Goal

Cut the first releases of the new series, including the merged unreleased fixes (owner, 2026-10-07: no `v0.1.1`), and move `admin` and `docs` to them.

## Scope

- CLI root tag: the CLI continues the existing root series (next version after `v0.1.0`). The new series start at `0.1.0`: `web/v0.1.0`, and per-Action `v0.1.0` after deleting the Action repositories' old product `v0.1.0` tags (allowed during 0.x).
- Order: `admin` and `docs` repin each Action to its new `v0.1.0` first; only then does `admin/artifact-pages.yaml` gain `cli` and `web` (older CLIs reject the keys). Then run `config check`, `registry sync`, `app deploy` and a site sync on production.

## Acceptance criteria

- [ ] Releases published and verified by their workflows.
- [ ] Production checks pass; sites report their writing CLI in storage records.
- [ ] STATUS.md and the overview board updated.
