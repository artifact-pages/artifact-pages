# IMP-75 — Migrate `admin` and `docs` to admin-provided workflows

- Status: Done
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

## Verified outcome (2026-10-11)

The admin migration merged in [admin PR #12](https://github.com/artifact-pages/admin/pull/12) at [`218ff79700ab27b674f04730a0111e536ecbdb6b`](https://github.com/artifact-pages/admin/commit/218ff79700ab27b674f04730a0111e536ecbdb6b). The registry setup run [38116306865](https://github.com/artifact-pages/admin/actions/runs/38116306865) and generated-file drift-check run [38116306873](https://github.com/artifact-pages/admin/actions/runs/38116306873) both succeeded on `main`.

The docs workflow migration merged in [docs PR #23](https://github.com/artifact-pages/docs/pull/23) at [`fbd556d54127e7a49b7faf7918e37b050872184a`](https://github.com/artifact-pages/docs/commit/fbd556d54127e7a49b7faf7918e37b050872184a). The main publish wrapper run [38116554387](https://github.com/artifact-pages/docs/actions/runs/38116554387) succeeded as a no-op under `publish-on`. The updated guide preview from [docs PR #24](https://github.com/artifact-pages/docs/pull/24), merged at [`109ad7612baed0d2ac041845b031db67ddb93e1f`](https://github.com/artifact-pages/docs/commit/109ad7612baed0d2ac041845b031db67ddb93e1f), succeeded in [preview run 38116791375](https://github.com/artifact-pages/docs/actions/runs/38116791375) and returned previews for all four changed guide pages.

The forced publish dry-run for both sites succeeded in [run 38117460867](https://github.com/artifact-pages/docs/actions/runs/38117460867). The `workflow_dispatch` ran from temporary branch `codex-imp75-main-dryrun` at `a0ed10c543e63adc07818589839a0b4483cbf6ac`; it checked out the exact merged docs `main` source at `fbd556d54127e7a49b7faf7918e37b050872184a`, used the admin config at `218ff79700ab27b674f04730a0111e536ecbdb6b` and the pinned CLI v0.3.0, and forced dry-run behavior through `publish-on`. This was a main-source dry-run dispatched from a temporary branch, not a run whose ref was `main`.

## Acceptance criteria

- [x] A docs pull request previews through the admin-provided workflow, and an explicitly forced publish dry-run against both `main` sites succeeds (the dry-run dispatch ran from a temporary branch while checking out the exact merged `main` source; see run 38117460867 above).
- [x] The docs workflows no longer carry a config locator, token or pinned Action SHA; the migration is merged in docs PR #23.
- [x] The admin CI runs the generated-file drift check; run 38116306873 succeeded on the generated files merged in admin PR #12.
