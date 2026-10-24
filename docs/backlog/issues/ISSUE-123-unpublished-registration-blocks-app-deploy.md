# Never-published registrations block app deploy compatibility checks

- Status: Open
- Priority: P1
- Area: CLI app deployment / stored-format compatibility

## Problem

An operator who registers a site before its first publish cannot deploy the app normally, including in dry-run. Missing version records for a genuinely empty registration are treated as incompatible stored content. This forces a breaking-change override even though that site has no reader content to break.

## Evidence and reproduction

**Cloudflare local scoped-credential evidence (CLI 0.4.4 darwin_arm64); not hosted Actions/OIDC.** Sources: `~/.config/artifact-pages-verify/a6-20261024/a6-runbook.md` D11/Q1, `evidence/pre/NOTES.md`, `evidence/A6-NOTES.md` and `evidence/A7-NOTES.md`.

1. Register a site without publishing it; leave registration membership intact.
2. Run released CLI 0.4.4 `app deploy --dry-run` against a compatible bundle.
3. `compatibility.go` `checkStoredFormats` rejects the absent `_control/sites/<id>/versions.json` with `<id>: unknown; republish with: …`. The run's no-flag dry-runs failed on exactly `smoke`, `verify-scale-10`, `verify-scale-100`, `verify-scale-1000`, `verify-scale-5000`, `verify-scale-10000`; A4 contained no content/control keys for those sites. Each actual proof deploy needed an owner-approved, app-only `--accept-breaking` exception after verifying that exact set. This exception is evidence of impact, not the general fix.

## Expected outcome

Backend decision for this follow-up: a registration with **confirmed absent published projection and absent format record** has no stored format to validate and should not block app deployment. Dry-run and write use the same classification under existing consistency/locking rules. Do not infer never-published status merely from a missing version record: existing production or preview content with unknown formats must still fail closed. Denied, unavailable or incomplete origin reads must remain errors. No automatic republish, unregister, control-record deletion or broad override is appropriate.

This records the proposed repair outcome; accepted behavior remains in `docs/specification.md`, which must be updated when the repair is adopted.

## Acceptance criteria

- [ ] A compatible bundle deploy and dry-run succeed without `--accept-breaking` when an otherwise compatible registry contains a confirmed empty, never-published site; registration stays unchanged.
- [ ] Published production or preview content without a valid format record still blocks deploy; incompatible records and denied/unavailable absence checks still fail safely.
- [ ] Regression coverage distinguishes those states and prevents publication between the empty-site check and deployment from bypassing compatibility validation.
