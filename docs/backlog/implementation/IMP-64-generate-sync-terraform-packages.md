# IMP-64 — Generate and sync a Terraform package repository on a per-module tag

- Status: In progress
- Assignee: Codex
- Lanes: CLI / release, Terraform
- Depends on: [IMP-63](IMP-63-consolidate-terraform-modules.md), [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) (re-scoped 2026-10-07), [TD14](../technical-design/TD14-one-repository-per-action.md) (mechanism to reuse)
- Blocks: [IMP-65](IMP-65-admin-module-source-switch.md), [IMP-38](IMP-38-terraform-registry-publication.md)
- Related: [IMP-66](IMP-66-per-site-control-prefix-and-aws-iam.md) (precondition for decoupled AWS releases, not for this slice)

## Goal

When a module tag `terraform-cloudflare/vX.Y.Z` or `terraform-aws/vX.Y.Z` is pushed in the monorepo, replace `main` of `artifact-pages/terraform-cloudflare-artifact-pages` or `artifact-pages/terraform-aws-artifact-pages` (only the matching one) with a tree generated from `terraform/modules/<provider>/`, tag the package repository with the plain `vX.Y.Z` and push, using the organization App. Module versions are independent of the product version; product releases do not run this flow (TD15 2026-10-07).

## Scope

- `scripts/build-terraform-package-repos.mjs` (with tests, like `build-action-repos.test.mjs`): takes a module name and version, generates the Registry layout from TD15 (root files, `modules/`, `examples/`, `tests/`, `LICENSE`, `release.json` with module version and source tag, generated-copy and "send PRs to the monorepo" notice in the README) and rewrites example sources from relative paths to the Registry address with the exact version.
- `scripts/sync-terraform-package-repos.sh`, modelled on `scripts/sync-action-repos.sh`: replace `main`, commit, tag plain `vX.Y.Z`, push; a rerun with identical content is a no-op and a difference at an existing tag fails.
- `.github/workflows/release-terraform.yml`, separate from `release.yml` (which stays unchanged and keeps triggering on `v*` only), triggered by `terraform-cloudflare/v*` and `terraform-aws/v*`: validates the tag is SemVer and on `main`, builds and validates the tree, then syncs. Token from `actions/create-github-app-token` (`RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`) scoped to the one package repository; the repository's own `GITHUB_TOKEN` stays `contents: read`. A `workflow_dispatch` dry-run mode prints the plan without pushing.
- No-op guard: refuse (or no-op) when the generated tree equals the previous release's tree, so an unchanged module cannot receive a new version by accident.
- Package repositories get a generated notice and a pull-request auto-close workflow (comment pointing to `artifact-pages/artifact-pages`), as for the Action repositories, shipped as part of the generated tree so the sync keeps them in place.
- Resolve the TD15 open points that belong here (lock files, validation of the generated tree before tagging). Initial versions are decided: both modules start at `0.1.0`, and `release.json` records `version`, `repository`, the source tag and the source commit SHA.
- Owner step (not an agent step): install the App `artifact-pages-release` on the two package repositories with Contents write (and Pull requests write if the auto-close workflow uses the App token; otherwise the workflow's own `GITHUB_TOKEN` suffices). It currently has Contents write only on the four Action repositories.

## Acceptance criteria

- [ ] The first releases are `terraform-cloudflare/v0.1.0` and `terraform-aws/v0.1.0`.
- [x] Generator tests cover the layout, the example rewrite, determinism (two runs produce identical trees), refusal on a missing module file, and that the generated `release.json` carries the module version and source tag.
- [x] CI validates the generated trees (`terraform fmt -check`, `init -backend=false`, `validate`, and the module tests) without network writes.
- [x] Pushing `terraform-<provider>/vX.Y.Z` is wired to sync only the matching package repository and tag plain `vX.Y.Z` there; the product workflow retains only its existing tag patterns, and a module tag is isolated to the Terraform workflow.
- [x] A dry-run of the sync (local or `workflow_dispatch`, no push) prints the planned commit and tag for the selected module.
- [x] A second run with identical content is a no-op; different content at an existing tag fails; an unchanged module is not released under a new version (no-op guard).
- [ ] After the owner installs the App, a real module release syncs the package repository; it contains no content that is absent from the monorepo.
- [ ] Each package repository carries the generated-repository notice and the PR auto-close workflow, verified by opening and closing a test pull request.
- [x] The release documentation ([release readiness](../release-readiness.md)) lists the new workflow, the tag shapes and the owner step.

## Results

Local implementation and verification are complete for the source-controlled portion. `npm run test:terraform-packages` passes 15 tests, the existing Action release test passes 13 tests, and generated Cloudflare and AWS package trees both pass their full `scripts/validate.sh` under Terraform 1.9.8. The package comparison normalizes only `release.json` version/source metadata and the Registry consumer's exact module version; README, LICENSE, generated workflow and executable-mode changes remain content changes. Release tags accept only plain `X.Y.Z`, matching TD15's `vX.Y.Z` package tag contract; prerelease/build suffixes are rejected.

The owner installed `artifact-pages-release` on both package repositories on 2026-10-10 with Contents write and Metadata read. The generated pull-request guard uses each package repository's own `GITHUB_TOKEN`, so the App does not need Pull requests write. No first module tag, real package sync, Registry publication or test pull request was run: the owner's approval for an actual tag/sync remains pending, and acceptance criteria 1, 7 and 8 stay open for that external proof.
