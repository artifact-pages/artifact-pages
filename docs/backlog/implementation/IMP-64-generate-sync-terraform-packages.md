# IMP-64 — Generate and sync the Terraform package repositories on release

- Status: Open
- Lanes: CLI / release, Terraform
- Depends on: [IMP-63](IMP-63-consolidate-terraform-modules.md), [TD15](../technical-design/TD15-terraform-module-source-of-truth.md), [TD14](../technical-design/TD14-one-repository-per-action.md) (mechanism to reuse)
- Blocks: [IMP-65](IMP-65-admin-module-source-switch.md), [IMP-38](IMP-38-terraform-registry-publication.md)

## Goal

On each release, replace `main` of `artifact-pages/terraform-cloudflare-artifact-pages` and `artifact-pages/terraform-aws-artifact-pages` with a tree generated from `terraform/modules/<provider>/`, tag it `vX.Y.Z` (the product version) and push, using the organization App.

## Scope

- `scripts/build-terraform-package-repos.mjs` (with tests, like `build-action-repos.test.mjs`): generates the Registry layout from TD15 (root files, `modules/`, `examples/`, `tests/`, `LICENSE`, `release.json`, generated-copy note in the README) and rewrites example sources from relative paths to the Registry address with the exact version.
- `scripts/sync-terraform-package-repos.sh`, modelled on `scripts/sync-action-repos.sh`: replace `main`, commit, tag, push; a rerun with identical content is a no-op and a difference at an existing tag fails.
- `release.yml`: a job after `verify-published`, token from `actions/create-github-app-token` (`RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`) with the two package repositories added to the repository list; the repository's own `GITHUB_TOKEN` stays `contents: read`.
- Resolve the TD15 open points that belong here (lock files, validation of the generated tree before tagging, tag-on-unchanged rule).
- Owner step (not an agent step): install the App `artifact-pages-release` on the two package repositories with Contents write. It currently has Contents write only on the four Action repositories.

## Acceptance criteria

- [ ] Generator tests cover the layout, the example rewrite, determinism (two runs produce identical trees) and refusal on a missing module file.
- [ ] CI validates the generated trees (`terraform fmt -check`, `init -backend=false`, `validate`, and the module tests) without network writes.
- [ ] A dry-run of the sync (local or `workflow_dispatch`, no push) prints the planned commits and tags for both repositories.
- [ ] After the owner installs the App, a real release syncs both repositories and tags `vX.Y.Z`; the package repositories contain no content that is absent from the monorepo.
- [ ] The release workflow documentation ([release readiness](../release-readiness.md)) lists the new job and the owner step.

## Results

Not started.
