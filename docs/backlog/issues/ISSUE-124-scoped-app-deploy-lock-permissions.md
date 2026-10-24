# Scoped app-deploy permission guidance omits registry and site locks

- Status: Open
- Priority: P2
- Area: Operator permissions / app deployment documentation

## Problem

A scoped app-deploy credential that covers app writes and format reads can still fail on lock acquisition. Operators need a complete lock permission contract to prepare a working credential, including the effect on registered but unpublished sites.

## Evidence and reproduction

**Cloudflare local scoped-credential evidence (CLI 0.4.4 darwin_arm64); not hosted Actions/OIDC.** Sources: `~/.config/artifact-pages-verify/a6-20261024/evidence/NOTES-A6-part1.md`, `A6-NOTES.md`, `RESTORE-NOTES.md`; runbook D4/D5. No new provider operations are requested by this item.

1. Use the runbook's initial app child scope, which omitted `_control/locks/registry.json`, on CLI 0.4.4 with a bundle declaring reads.
2. A1 app deploy failed `AccessDenied` reported as `read site lock` before app-visible writes; the application lock was released, no retry record remained.
3. Owner approved adding the registry lock. Deployment succeeded with that grant and the existing `_control/sites/` scope. Six free `_control/sites/<id>/lock.json` objects were created for the original never-published registrations and were later included in the 90-key owner-approved restoration cleanup.

The runbook's v0.4.4 source review (`publish.go:252–284`) and the lock-path condition explain that a write acquires the application lock, then the registry lock and every registered site's lock when `len(bundle.manifest.Reads) > 0 || compatibilityOptions(ctx).Pinned`. Thus pinned compatibility requires those registry/site locks even when the bundle declares no reads. It is not sufficient to grant only the app lock and version-record reads. Dry-run returns `operation()` before this block and acquires none of the application, registry or site locks.

## Expected outcome

Operator guidance must enumerate `_control/locks/application.json`, `_control/locks/registry.json` and every registered site's `_control/sites/<id>/` lock prefix, with the read/write/conditional operations needed by that CLI version, distinguishing writes with declared bundle reads or pinned compatibility from dry-run, which requires none of these locks. Distinguish required lock authority from format/registry reads and the residual authority of R2's action set across granted paths (D4). Explain free-lock creation for empty registrations; do not recommend blind lock deletion or grant legacy `_control/locks/sites/*` just to work around denial.

The proposed empty-registration compatibility repair in [ISSUE-123](ISSUE-123-unpublished-registration-blocks-app-deploy.md) additionally depends on reads/listings of every registered site's `_indexes/<id>/` and `_artifacts/<id>/` prefixes, which the documented D4 app scope does not grant for all registrations. Cover that dependency in the scoped examples when the repair is adopted; lock grants do not establish absence of published content.

The monorepo documentation backlog is a frozen historical copy. Keep this actionable operator problem here; the eventual public guide correction belongs in `artifact-pages/docs`, coordinated with the maintained permission examples. No external repository changes are part of this record.

## Acceptance criteria

- [ ] Maintained app-deploy permission guidance/examples enumerate application lock access for writes and registry/all-site lock access when the bundle declares reads **or compatibility is pinned**, with CLI version scope and R2 residual authority stated. State that dry-run needs none of these lock grants.
- [ ] Guidance explains free lock objects on unpublished registrations and safe cleanup boundaries, and distinguishes denial from confirmed absence.
- [ ] Review rendered scoped credential examples separately for dry-run (read permissions, no application/registry/site lock grants) and writes (application lock plus registry/all-site locks for declared reads or pinned compatibility), including ISSUE-123's proposed absence-read dependency; any live validation needs separate owner authorization. Explain the observed `read site lock` error well enough for an operator to identify the missing registry-lock grant.
