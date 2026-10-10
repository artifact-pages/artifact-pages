# IMP-75 — Migrate `admin` and `docs` to admin-provided workflows

- Status: Open
- Lanes: Operator repositories
- Owner: Codex (operator repositories; production deploy steps need owner approval)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md), IMP-73
- Blocks: IMP-76

## Goal

`artifact-pages/admin` adopts the generated reusable workflows and composite action; `artifact-pages/docs` becomes a site repository that calls them (TD18 decision 9).

## Scope

- Generate the admin files with `registry setup`, commit them and add `registry setup --check` to the admin CI.
- Replace the publish and preview workflows in `docs` with calls to `artifact-pages/admin/.github/workflows/{publish,preview}-site.yml@main`; keep the same-repository gate on the preview call and the existing `publish-on` gating.
- Keep production secrets scoped as documented in the workspace guidance; confirm `secrets: inherit` supplies them to the called workflow.
- Document the private-admin Actions access setting if either repository is or becomes private.

## Acceptance criteria

- [ ] A docs pull request previews through the admin-provided workflow and a main publish dry-run succeeds for both sites.
- [ ] The docs workflows no longer carry a config locator, token or pinned Action SHA.
- [ ] The admin CI fails when the generated files drift.
