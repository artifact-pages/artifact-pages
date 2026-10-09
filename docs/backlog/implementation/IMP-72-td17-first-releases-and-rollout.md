# IMP-72 — First releases under TD17 and operator rollout

- Status: In progress
- Assignee: Codex
- Lanes: CLI / release, Operator repositories
- Owner: Codex (owner approval for each release, tag, deletion and production step)
- Depends on: [TD17](../technical-design/TD17-config-pinned-component-versions.md), IMP-68, IMP-69, IMP-70, IMP-71
- Blocks: —

## Goal

Cut the first releases of the new series, including the merged unreleased fixes (owner, 2026-10-07: no `v0.1.1`), and move `admin` and `docs` to them. This preparation targets the CLI release PR; release and production execution remain separate owner-approved steps.

## Release and rollout order

Keep this order when the owner authorizes execution. Every tag push, old Action tag deletion, release and production write needs its own approval.

1. After the owner approves the reviewed CLI release PR, merge it with `cli/internal/version.Product` set to `0.2.0`, Action `bootstrapCli` set to `0.2.0` and `cliRange` set to `>=0.2.0 <0.3.0`. The published CLI `v0.1.0` predates IMP-70: it does not re-exec to a pinned CLI and its strict config parser rejects the new `cli` and `web` keys.
2. After main CI is green, owner approves and pushes CLI tag `v0.2.0`. `release.yml` publishes and verifies the four CLI binaries, checksums, notices and compatibility JSON.
3. Owner approves and pushes web tag `web/v0.1.0`. This publishes and verifies the independent web bundle required by `web.version`.
4. For each Action, one at a time, owner approves deleting the existing generated-repository `v0.1.0` tag, then approves the corresponding monorepo tag: `publish-action/v0.1.0`, `preview-action/v0.1.0`, `registry-action/v0.1.0`, `app-deploy-action/v0.1.0`. Each tag triggers the generated-repository sync and requires the already-published CLI `v0.2.0` assets.
5. Before merging either operator pin change, put both automatic write workflows in an explicit hold. For `docs` Publish, keep the workflow trigger but set `publish-on` to `workflow_dispatch:refs/heads/main`, so every push (including the pin merge) is a dry-run. Keep both holds through the final acceptance check. For `admin` Registry, set `publish-on` to `workflow_dispatch:refs/heads/main`, so config pushes are dry-runs. Docs Publish currently triggers on every push to `main`; admin Registry triggers on `artifact-pages.yaml` pushes. Both currently make matching pushes real writes. After the generated repositories exist, update the Action pins in `admin` and `docs`. Both repositories already use the same textual `@v0.1.0` refs, so rewritten generated-repository tags create no pin diff. Use each new generated commit's full SHA with a `# v0.1.0` comment to make the selected payload explicit and immutable. Each pin merge needs separate owner approval.
6. After a separate owner approval, update production `admin/artifact-pages.yaml` to set `cli.version: 0.2.0` and `web.version: 0.1.0`. Its held Registry workflow runs a dry-run on the main push. The already-published CLI `v0.1.0` cannot process these keys; the new CLI and Actions must be pinned first.
7. After a separate owner approval, run `artifact-pages config check --config artifact-pages.yaml` as the first production read-only diagnostic. With the existing pre-TD17 projection, expect unknown registry and site version records; `CheckConfig` always checks with `acceptBreaking=false`. Record the expected result and stop on any other compatibility errors. This check is not expected to pass yet and must not be presented as passing.
8. After a separate owner approval, manually dispatch the held Registry workflow on `main` to run `artifact-pages registry sync --config artifact-pages.yaml` and write the registry version record. If it reports an incompatibility requiring `--accept-breaking`, stop for a separate approval explicitly naming that flag.
9. Before the first site write, inventory all registered sites' version records and `_previews/<site>/catalog.json` plus every `_previews/<site>/revisions/*/manifest.json` read-only. The current config registers `guide` and `architecture`. Their old site projections are expected to need a record, which `site sync` writes. If retained preview data is not represented by its version record, stop and obtain separate approval for the required preview republish or cleanup; a normal site sync does not certify unrecorded preview formats. Do not claim the later config check will pass until every retained record is complete.
10. After a separate owner approval, manually dispatch the held docs Publish workflow on `main` to run `artifact-pages site sync` for every registered site (`guide` and `architecture`). The workflow's site matrix runs both. Keep push-triggered runs dry-run during the pin/config changes; use only this approved dispatch for the site writes. If any site sync or completeness check reports unknown or incompatible retained data, stop for separately approved remediation before deploying the app.
11. After a separate owner approval, run `artifact-pages app deploy --config artifact-pages.yaml` without `--accept-breaking`, after registry and all site records have been written. With compatible preview records, the application check should now accept the stored formats; if it does not, stop and report the specific record rather than bypassing it.
12. After a separate owner approval, run `artifact-pages config check --config artifact-pages.yaml` as the final acceptance check. It must pass, and the registry plus every site's records must name CLI `0.2.0` as their writing CLI. If this check reports an unknown retained preview format, record and separately approve its remediation before claiming the rollout complete.
13. After the final check, obtain separate owner approval to end both temporary workflow holds. Restoring the admin Registry `publish-on` guard does not match its `artifact-pages.yaml` push filter, so that workflow-file change triggers no registry write. Restoring docs Publish `publish-on: push:refs/heads/main` in a merge itself triggers a production run for both sites, so that approval must explicitly cover the resulting site sync. If no additional site write is approved, leave docs with the dispatch-only guard so pushes stay dry-run and future publishes require an approved manual dispatch.

The initial failed `config check` is diagnostic: it cannot certify missing records. `registry sync` creates the registry record; site syncs create the production site records before `app deploy`; then the final check validates the completed rollout. The release and published Action series unblock DOC-18 only after both operator repositories are pinned to them. At that gate, notify the owner so Claude can resume DOC-18; do not change its ticket or message another task during this preparation.

## Current preparation scope

- Set the CLI product version and Action bootstrap/range for the first post-IMP-70 CLI release.
- Update focused generator fixtures and tests, then generate the four candidate Action records locally.
- Do not edit `admin` or `docs`, push tags, delete Action tags, publish releases, merge a release PR, run production checks/writes, or update the overview board in this preparation slice.
- The overview board is Claude-owned; hand off the final rollout status when those owner-approved steps occur.

## Acceptance criteria

- [ ] CLI release PR sets Product `0.2.0`; every generated Action record for its first `0.1.0` release bootstraps CLI `0.2.0` and declares `>=0.2.0 <0.3.0`.
- [x] Focused release/generator tests pass and the four local records are inspected.
- [ ] Approved release and operator workflows complete in the order above, including the initial diagnostic and final successful `config check`.
- [ ] Production checks pass; sites report their writing CLI in storage records.
- [ ] `STATUS.md` and the Claude-owned overview board reflect the completed rollout.

## Preparation findings

- `docs/.github/workflows/publish.yml` runs on every push to `main`; merging its Action pin PR before the planned site sync would publish early unless the workflow is held.
- `admin/.github/workflows/registry.yml` runs on every push to `artifact-pages.yaml`; merging the new component pins would write the registry before the explicit check/sync gate unless main pushes are made dry-run-only.
- `config check` reads version records without a bypass. Existing site projections without IMP-69 records produce `registry: unknown` and `<site>: unknown; republish required`. After registry sync and a successful sync of every registered site, ordinary `app deploy` should pass without `--accept-breaking`, provided no retained preview catalog or revision manifest lacks a readable version record. `checkSiteRecordCompleteness` reports such preview data as unknown until its formats are recorded or the data is explicitly republished/cleaned up; inventory it before site sync and stop for separately approved remediation if needed.
- Operator Action refs currently already say `@v0.1.0` (admin: registry/app-deploy; docs: publish/preview), so exact SHAs with version comments are the proposed way to make the repins visible and immutable after each generated tag is replaced.
- The docs guide's published `versions.html` already explains independent CLI/web/Action releases, config pins, Action bootstrap/ranges and storage compatibility records. DOC-18 is still blocked because the neighboring walkthrough pages retain old command/install/repository references; its unlock condition is published CLI, web and Action releases **and** both `admin`/`docs` pinned to them.
- `TestLegacyProjectionMigratesThroughPlannedOrder` uses the candidate pinned context (`cli.version: 0.2.0`, `web.version: 0.1.0`) and a temporary backend. It checks the initial unknown-record diagnostic, registry sync, the remaining site-only diagnostic, site sync, a passing config check before app deploy, ordinary app deploy without `--accept-breaking`, the final passing config check, and CLI `0.2.0` on registry/site writer records. Its fixture has no retained previews; production inventory still needs to inspect preview catalogs and manifests.
- Verification on 2026-10-09: `npm run test:action-repos` passed 13/13 tests, `npm run test:cli-release` passed 3/3, `go test -count=1 ./cli/internal/publisher -run '^TestLegacyProjectionMigratesThroughPlannedOrder$'` passed, and `go test ./cli/cmd/artifact-pages -run 'TestRunVersionPrintsProductVersionAndRevision|TestCompatibilityAssetCommand'` passed both selected tests. `node scripts/build-action-repos.mjs --version 0.1.0 --out .local/imp72-action-repos` generated all four records; each was inspected as Action `0.1.0`, bootstrap CLI `0.2.0`, range `>=0.2.0 <0.3.0`. `git diff --check` passed.
