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
5. Before merging the `docs` pin change, gate its `Publish` workflow by removing `push:refs/heads/main` from `publish-on`; push-triggered runs then stay dry-run. The current push trigger matches every main push, so pin changes would otherwise publish production early. Keep the hold through app deploy. Update the Action pins in `admin` and `docs` after the generated commits exist. Both repositories already use the same textual `@v0.1.0` refs, so rewriting the generated repositories' 0.x tags creates no reviewable pin diff. Use each new generated commit's full SHA with a `# v0.1.0` comment in the operator workflows to make the selected payload explicit and immutable.
6. Update the production `admin/artifact-pages.yaml` config to set `cli.version: 0.2.0` and `web.version: 0.1.0`. Before that config change merges, gate the `Registry` workflow so main pushes dry-run and only an approved manual dispatch writes. Its current push trigger matches every change to `artifact-pages.yaml` and runs a real sync.
7. Run `config check` as the first read-only diagnostic after the config change. With the existing pre-TD17 projection, expect it to report unknown registry/site version records; `CheckConfig` always checks with `acceptBreaking=false`. Record the output and stop on other compatibility errors. This check is not expected to pass yet and must not be presented as passing.
8. After a separate owner approval, run `registry sync` to write the registry version record. If it reports an incompatibility requiring `--accept-breaking`, stop and obtain approval explicitly naming that flag.
9. Before `app deploy`, inventory site version records, `_previews/<site>/catalog.json` and `_previews/<site>/revisions/*/manifest.json` read-only. If any sites lack readable records, ordinary deploy rejects the unknown formats; prepare `app deploy --accept-breaking` and get separate owner approval explicitly naming the flag. Use ordinary deploy only when the inventory and compatibility checks pass without it. If retained preview data is not represented by its version record, record the required republish or cleanup remediation and obtain approval before performing it; neither app deploy nor a production site write makes unrecorded previews compatible automatically.
10. After a separate owner approval, run the production site sync for every registered site. The current admin config registers `guide` and `architecture`, and the docs Publish workflow matrix runs both. Restore `push:refs/heads/main` in the held Publish workflow only as this final approved step; the restoration push runs both sites. Do not also dispatch the workflow. Re-run `config check` after all required site and preview-record remediation, and record the successful result.

The rollout stays in this order. The initial failed `config check` is diagnostic: it cannot certify missing records, and the web deploy cannot write site records. Registry sync, app deploy and the site sync establish those records in sequence; the final check is the acceptance check.

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
- `config check` reads version records without a bypass. Existing site projections without IMP-69 records produce `registry: unknown` and `<site>: unknown; republish required`. After `registry sync`, `app deploy` still needs an explicit `--accept-breaking` approval when a site record is missing. A site write does not certify retained unrecorded preview catalogs or revision manifests; `checkSiteRecordCompleteness` reports those as unknown until their formats are recorded or the data is explicitly republished/cleaned up.
- Operator Action refs currently already say `@v0.1.0` (admin: registry/app-deploy; docs: publish/preview), so exact SHAs with version comments are the proposed way to make the repins visible and immutable after each generated tag is replaced.
- `TestLegacyProjectionMigratesThroughPlannedOrder` exercises the expected unknown-record diagnostic, registry record write, refusal of ordinary app deploy, separately approved `--accept-breaking` deploy, site sync and final successful config check against a temporary local backend. Its fixture has no retained previews; production inventory still needs to inspect preview catalogs and manifests.
- Verification on 2026-10-09: `npm run test:action-repos` passed 13/13 tests, `npm run test:cli-release` passed 3/3, `go test -count=1 ./cli/internal/publisher -run '^TestLegacyProjectionMigratesThroughPlannedOrder$'` passed, and `go test ./cli/cmd/artifact-pages -run 'TestRunVersionPrintsProductVersionAndRevision|TestCompatibilityAssetCommand'` passed both selected tests. `node scripts/build-action-repos.mjs --version 0.1.0 --out .local/imp72-action-repos` generated all four records; each was inspected as Action `0.1.0`, bootstrap CLI `0.2.0`, range `>=0.2.0 <0.3.0`. `git diff --check` passed.
