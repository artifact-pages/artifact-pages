# IMP-76 — Retire the private-config fixture, App and workflow

- Status: Done
- Assignee: Codex
- Lanes: CI, Operator repositories
- Owner: Codex (owner approval required for repository and App deletion)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md), IMP-75
- Blocks: —

## Goal

After `admin` and `docs` use the admin-provided workflows, retire the private-config CI fixture. On 2026-10-11 the owner also decided to remove the Actions' `github-token` input, while keeping the CLI `github://` locator and its local/admin authentication behavior.

## Scope

- Remove the `github-token` input from all four composite Actions and use the workflow token for config/API reads. Keep `ARTIFACT_PAGES_FETCH_TOKEN` as the separate credential channel for repository history fetches.
- Remove `.github/workflows/private-config.yml` and checks dedicated to that fixture; keep generic CLI `github://` locator tests.
- Delete the `artifact-pages/fixture-private-config` repository, the `artifact-pages-ci-fixture` GitHub App, and the monorepo repository-scoped `FIXTURE_APP_ID` variable and `FIXTURE_APP_PRIVATE_KEY` secret only after IMP-75 is verified and the owner approves the concrete deletion.
- Update the official guide and specification text that describes the retired Action input. The narrow guide scope is announced in workspace `STATUS.md`; keep the CLI `github://` locator documentation.

## Current status (2026-10-11)

The source change merged in [monorepo PR #81](https://github.com/artifact-pages/artifact-pages/pull/81) at [`ee6cc1e09d855dba31672c52a160772488534a68`](https://github.com/artifact-pages/artifact-pages/commit/ee6cc1e09d855dba31672c52a160772488534a68), after independent review and green CI. The four-page guide update merged in [docs PR #24](https://github.com/artifact-pages/docs/pull/24) at [`109ad7612baed0d2ac041845b031db67ddb93e1f`](https://github.com/artifact-pages/docs/commit/109ad7612baed0d2ac041845b031db67ddb93e1f). Post-merge publish run [38117652268](https://github.com/artifact-pages/docs/actions/runs/38117652268) succeeded: the `guide` site synced the four changed HTML pages and guide index, while `architecture` was a no-op. A separate post-publish check confirmed all four changed public pages return HTTP 200 and their SHA-256 hashes match the source at `109ad7612baed0d2ac041845b031db67ddb93e1f`.

Owner-approved retirement completed on 2026-10-11. Read-only GitHub checks returned 404 for repository `artifact-pages/fixture-private-config` (ID `1406482610`), GitHub App `artifact-pages-ci-fixture` (ID `5211527`) and installation `168523492`. Subsequent repository listings confirmed `FIXTURE_APP_ID` and `FIXTURE_APP_PRIVATE_KEY` are absent. The protected fixture config/export and App-selection evidence remain under `~/.config/artifact-pages/imp76-fixture-retirement/`.

## Acceptance criteria

- [x] Source removes the Action input and fixture-only workflow/check while preserving the CLI `github://` locator and tests.
- [x] Verify IMP-75 migration, then merge the source change after independent review and green CI (monorepo PR #81; IMP-75 verification is recorded in its ticket).
- [x] Retire the repository, App and installation, variable and secret with the owner's recorded approval; read-only checks verified the repository, App and installation return 404 and both credential names are absent.
- [x] No official guide page presents the retired Action input as a site topology; all four changed pages were verified against the merged source after publish run 38117652268.
