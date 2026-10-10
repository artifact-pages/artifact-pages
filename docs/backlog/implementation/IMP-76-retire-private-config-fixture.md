# IMP-76 — Retire the private-config fixture, App and workflow

- Status: Open
- Lanes: CI, Operator repositories
- Owner: Codex (owner approval required for repository and App deletion)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md), IMP-75
- Blocks: —

## Goal

After `admin` and `docs` use the admin-provided workflows, the Action `github-token` private-config topology leaves the official procedure (TD18 decision 8) and its fixtures go away.

## Scope

- Remove `.github/workflows/private-config.yml` and any smoke or regression check that only exists for it.
- Delete the `artifact-pages/fixture-private-config` repository and the `artifact-pages-ci-fixture` GitHub App, after owner approval.
- Keep the CLI `github://` locator and its tests (local and admin use).
- Update guides and the specification where they present the private-config topology as an official path.

## Acceptance criteria

- [ ] Main CI is green without the workflow.
- [ ] The repository and App are deleted with the owner's recorded approval.
- [ ] No official guide page presents `github-token` private config as a site topology.
