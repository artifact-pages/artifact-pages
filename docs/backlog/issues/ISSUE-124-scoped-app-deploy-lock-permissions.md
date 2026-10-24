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

The runbook's v0.4.4 source review (`publish.go:252–284`) explains that app deploy acquires the registry lock and every registered site's lock when the bundle declares reads. It is not sufficient to grant only the app lock and version-record reads.

## Expected outcome

Operator guidance must enumerate `_control/locks/application.json`, `_control/locks/registry.json` and every registered site's `_control/sites/<id>/` lock prefix, with the read/write/conditional operations needed by that CLI version. Distinguish required lock authority from format/registry reads and the residual authority of R2's action set across granted paths (D4). Explain free-lock creation for empty registrations; do not recommend blind lock deletion or grant legacy `_control/locks/sites/*` just to work around denial.

The monorepo documentation backlog is a frozen historical copy. Keep this actionable operator problem here; the eventual public guide correction belongs in `artifact-pages/docs`, coordinated with the maintained permission examples. No external repository changes are part of this record.

## Acceptance criteria

- [ ] Maintained app-deploy permission guidance/examples enumerate registry and all registered-site lock access for bundles declaring reads, with CLI version scope and R2 residual authority stated.
- [ ] Guidance explains free lock objects on unpublished registrations and safe cleanup boundaries, and distinguishes denial from confirmed absence.
- [ ] Review a rendered scoped credential example against the deployed CLI lock path; any live validation needs separate owner authorization. Explain the observed `read site lock` error well enough for an operator to identify the missing registry-lock grant.
