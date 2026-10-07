# IMP-68 — Split release series: CLI, web and per-Action tags

- Status: Open
- Lanes: CLI / release
- Owner: Codex
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md), IMP-67
- Blocks: IMP-72

## Goal

Replace the single product release with independent series (TD17 section 1): the root `vX.Y.Z` releases only the CLI, `web/vX.Y.Z` releases the web bundle, and `<name>-action/vX.Y.Z` generates and syncs one Action repository with plain `vX.Y.Z`.

## Scope

- `release.yml` (or separate workflows) per tag pattern. The CLI release keeps binaries, checksums, notices and the CLI compatibility asset (formats written, config versions read). The web release keeps the archive, manifest and `.sha256`, and the "web changed since the previous web release" note.
- Action sync per tag, with the generated-content check: tagging an unchanged Action fails, an untagged changed Action warns.
- Asset names keep `artifact-pages-web-…` for the web release (the component is called `web`).
- Only CLI releases are `make_latest`; web and Action releases set `make_latest: false`.
- During 0.x the Action sync may replace an existing tag (TD17 decision); from the first non-pre-release it refuses again.
- Compatibility gate: compares CLI candidates with the previous CLI release and web candidates with the previous web release; 0.x skip unchanged.

## Acceptance criteria

- [ ] Each tag pattern releases only its component; dry-run evidence for all three.
- [ ] Generated-content check covered by tests, including an `actions/shared/` change touching several Actions.
- [ ] No tag or release is pushed by this slice; the first real releases are IMP-72 (owner approval).
