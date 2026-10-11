# IMP-75 — Migrate `admin` and `docs` to admin-provided workflows

- Status: In progress
- Assignee: Codex
- Lanes: Operator repositories
- Owner: Codex (operator repositories; production deploy steps need owner approval)
- Depends on: [TD18](../technical-design/TD18-admin-provided-site-workflows.md), IMP-73 (source merged; CLI v0.3.0 released)
- Blocks: IMP-76

## Goal

`artifact-pages/admin` adopts the generated reusable workflows and composite action; `artifact-pages/docs` (sites `guide` and `architecture`) becomes a site repository that calls them (TD18 contract item 9).

## Scope

- Generate the admin files with `registry setup`, commit them and add `registry setup --check` to the admin CI.
- Replace the publish and preview workflows in `docs` with calls to `artifact-pages/admin/.github/workflows/{publish,preview}-site.yml@main`; keep the same-repository gate on the preview call and the existing `publish-on` gating.
- Keep the docs `production` and `preview` environment protection through the TD18 environment input; confirm `secrets: inherit` plus the environment supplies the secrets to the called workflow.
- Document the private-admin Actions access setting if either repository is or becomes private.

## Current status (2026-10-11)

The admin migration is merged at `218ff79700ab27b674f04730a0111e536ecbdb6b`; the docs workflow migration is prepared as local commit `f0271435ea976eb94955cc09963deeb929102aaa`.

The admin files were generated from the merged IMP-73 source with CLI v0.3.0, which was released on 2026-10-11. The admin registry migration is merged; hosted docs preview/publish acceptance remains pending. The acceptance criteria above remain open until those checks pass.

## Acceptance criteria

- [ ] A docs pull request previews through the admin-provided workflow and a main publish dry-run succeeds for both sites.
- [ ] The docs workflows no longer carry a config locator, token or pinned Action SHA.
- [ ] The admin CI fails when the generated files drift.
