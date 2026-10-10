# IMP-76 — Retire the private-config fixture, App and workflow

- Status: In progress
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
- Update official guide and specification text that describes the Action input. This is Claude's prose lane and will be coordinated separately.

**Pending gates:** IMP-75 migration verification; owner approval for repository/App/credential deletion; fresh independent review and green CI before source merge. The private repository and App still exist, and this item is not complete.

## Acceptance criteria

- [x] Source removes the Action input and fixture-only workflow/check while preserving the CLI `github://` locator and tests.
- [ ] Verify IMP-75 migration, then merge the source change after independent review and green CI.
- [ ] Delete the repository, App, variable and secret with the owner's recorded approval.
- [ ] No official guide page presents the retired Action input as a site topology.
