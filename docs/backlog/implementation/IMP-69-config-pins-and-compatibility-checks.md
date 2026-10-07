# IMP-69 — Config `cli`/`web` keys, storage version records and compatibility checks

- Status: Open
- Lanes: CLI
- Owner: Codex
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md), IMP-67
- Blocks: IMP-70, IMP-72

## Goal

The CLI reads `cli.version` and `web.version`, records versions in storage, and validates compatibility from release data and storage records (TD17 sections 2 and 3).

## Scope

- Config: `cli` and `web` keys (exact `MAJOR.MINOR.PATCH`), at most one layer may set either (exit 2 otherwise).
- Embedded compatibility data: formats and `schemaVersion`s written, config versions read; published as a CLI release asset (consumed by IMP-68).
- Storage records: `/_control/versions/app.json` (deployed web version and reads), `/_control/versions/registry.json`, `/_control/sites/<site>/versions.json` (writing CLI and formats), each `schemaVersion: 1`, written in the same locked operation as the data. Missing record = unknown.
- Checks: new `config check` (config `schemaVersion` readable; `web.version` reads every format this CLI writes and every format recorded per site, listing sites that need a republish or are unknown); `app deploy` against stored registry and site records; `site sync`, `preview publish`, `registry sync` against the deployed web (fallback `web.version`). `--accept-breaking` on `registry sync` and `app deploy`.
- `app deploy` installs `web.version` (from `web/vX.Y.Z`); `--archive` unchanged.
- AWS IAM needs no change: admin role already covers `_control/*`, satellites `_control/sites/<site>/*` (IMP-66).

## Acceptance criteria

- [ ] Unit tests for each check, unknown records and the fallback.
- [ ] Mixed-version local scenario: older web deployed, newer CLI refused; `--accept-breaking` path converges.
- [ ] Provider-delivery and Action smoke tests pass.
