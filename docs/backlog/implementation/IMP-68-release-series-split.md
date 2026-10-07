# IMP-68 — Split release series: CLI, web and per-Action tags

- Status: In progress
- Assignee: Codex
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

## Implementation and local verification (2026-10-08)

- `release.yml` resolves an exact component tag, checks main ancestry and routes to CLI/web asset publication or one generated Action repository. CLI publication contains binaries, checksums, notices and the embedded compatibility asset; web publication retains bundle provenance, archive/manifest/checksum and the previous-web byte comparison. Only the CLI publication requests latest.
- Action generation accepts an independent Action version and selected source directory, retaining the CLI pin until IMP-70 replaces `release.json` with the bootstrap contract. Generation compares the complete published payload and imported shared-script closure against each Action's previous tag. An unchanged selected Action fails; changed other Actions warn.
- Local bare-repository tests prove idempotent reruns, replacement of changed `v0.x` Action tags, refusal to move stable tags, and recovery after a partial sync. No remote GitHub tag, release or repository was changed.
- The CLI compatibility gate keeps the previous root CLI baseline and its mixed-version suite. Web releases compare the browser reader declaration against the previous `web/v*` baseline; removing a previously readable format/version is breaking and requires a major step after 1.0. The 0.x skip remains explicit. Legacy root `v0.1.0` does not become the first prefixed web baseline.
- Local dry-runs: root `v0.1.0`, `web/v0.1.0` and all four Action prefixes passed component/preflight/selected-generation checks; both first CLI/web gates skipped under the 0.x policy. YAML parsed and every release shell step passed `bash -n`. Focused Node suites: **33 passed** (`build-action-repos`, `compat-gate`, `release-notes`, `package-cli-release`). Tests use local fixture tags and file-based remotes only.
- Remaining before Done: independent review and integration with IMP-69's `compatibility --format json` export and config-pinned web deployment; then exercise actual local CLI packaging and archive deployment. First real component releases remain IMP-72 and require owner approval.
