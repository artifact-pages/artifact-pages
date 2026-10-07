# IMP-69 — Config `cli`/`web` keys, storage version records and compatibility checks

- Status: Done
- Assignee: Codex
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
- AWS IAM: admin role already covers `_control/*` and satellites cover `_control/sites/<site>/*` (IMP-66), but satellite `GetObject` needs an additional read-only grant for exactly `_control/versions/app.json`. Apply the updated module policy before deploying a CLI that checks the deployed web; no global control write grant is added. Cloudflare uses the existing read-only registry credential for that same exact global record.

## Acceptance criteria

- [x] Unit tests for each check, unknown records and the fallback.
- [x] Mixed-version local scenario: older web deployed, newer CLI refused; `--accept-breaking` path converges.
- [x] Provider-delivery and Action smoke tests pass.

## Implementation handoff (Codex, 2026-10-08)

- The binary embeds `cli/internal/compat/compatibility.json`; `artifact-pages compatibility --format json` exports `schemaVersion`, `cliVersion`, `configReads`, and `writes`. IMP-68 publishes this as `artifact-pages_vX.Y.Z_compatibility.json`. Format names match the web's supported-schema table and compatibility gate exactly.
- Legacy configs containing neither `cli` nor `web` retain the original unpinned flow when storage has no app version record. An existing app record is always checked. Either pin activates a required, verifiable deployed web or the `web.version` manifest fallback. Legacy root product bundles remain selectable only for those configs; new deployments must pin `web.version` to use `web/vX.Y.Z`.
- Version records use `schemaVersion: 1` and additive optional `pending: true` and per-format `pendingWrites` while a locked operation changes origin. Incomplete records are unknown to compatibility checks; a retry of the same operation repairs them. A writer in the other plane cannot clear incomplete writes it does not repair. Unsupported record schema versions fail even with `--accept-breaking`. Final records describe completed origin bytes, including after cache invalidation failure. `app remove` also removes the exact app version record.
- Before preview certification, every retained canonical immutable revision manifest is validated, including direct revisions absent from the current catalog. Unsupported history names the offending SHA and fails before any writes; use a CLI that supports it or explicitly clean that history. Confirmed lifecycle disappearance is skipped, while storage read/list errors fail closed.
- Site records merge previously recorded production and preview formats. A preview-only write cannot certify preexisting unrecorded production data; storage completeness checks name it as unknown. A production write similarly does not certify older preview catalogs it only prunes.
- App deployment acquires application, registry, then all registered-site locks in that order; sorted site acquisition and reverse release prevent deadlocks. It validates storage again and finalizes the app record while holding those locks, so site/preview writers cannot commit against an overtaken app snapshot. Normal publications for distinct sites still run independently.
- Registry reconciliation acquires affected existing-site and removed-site locks in sorted order before catalog mutation, validates their record schemas again under those locks, and reuses them for cleanup. This supersedes withdraw-before-cleanup-lock sequencing for this slice: an already-running publisher finishes before registry withdrawal. Both race orderings still converge to the unregistered, empty site, and version cleanup preserves the lock.
- Independent review covered the source implementation and the adversarial app/writer and retained-preview histories. No published tags, production configuration, live apply, or real deployment were changed.

## Verification (2026-10-08)

- `go test ./cli/...`, `go vet ./cli/...`, and focused tests for the exact Cloudflare read-only app-record credential route passed.
- `npm run test:provider-delivery`: 55/55; AWS control-key coverage includes the exact shared app-read exception and rejects all global writes. AWS WAF console tests: 73/73 with Terraform 1.16.4 after backend-free initialization; module formatting passed.
- Action shared tests: 52/52. `npm run test:actions-parity` passed with canonical `reads` in the generated test manifest, covering the strict compatibility flow across all four wrappers. The GitHub smoke job deploys the reader before first registration to avoid certifying unpublished sites.
- `npm run test:app-cache-rollback` passed: Chromium observed v1 → v2 → v1 asset revalidation and unchanged content planes. The unpinned legacy no-reads path remains covered separately.
- `npm run package:web -- --version 0.1.0-imp69-local` produced a real IMP-67 bundle with 101 files. A local Action-runner smoke installed it on empty storage, registered the committed smoke site, and published it; all typed exit codes were zero, the stored app reads matched the canonical table, and app/registry/site records were complete.
- Independent review found and verified repairs for app transitions overtaking a locked writer, unknown removed-site versions changing before cleanup locks, and retained older preview manifests being incorrectly certified. The committed tests and independent `-race` overlays prove the corrected orderings and fail-closed behavior.
