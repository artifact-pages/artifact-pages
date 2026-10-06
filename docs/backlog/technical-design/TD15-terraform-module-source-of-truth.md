# TD15 — Source of truth for the Terraform provider modules

- Status: In progress
- Phase: Reusable distribution
- Decision: The owner chose **option 1** on 2026-10-06: the monorepo is the source of truth for the Terraform modules, and the package repositories `artifact-pages/terraform-cloudflare-artifact-pages` and `artifact-pages/terraform-aws-artifact-pages` become generated and synced on release, like the Action repositories ([TD14](TD14-one-repository-per-action.md)). The contract below is settled except for the points listed under "Open points", so the item stays In progress.
- Related issue: [ISSUE-069](../issues/ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) (its fix exists only in the package repository)
- Related implementation: [IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md), [IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md), [IMP-65](../implementation/IMP-65-admin-module-source-switch.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md), [IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md), [IMP-44](../implementation/IMP-44-aws-waf-custom-rules.md)
- Related design: [TD14](TD14-one-repository-per-action.md) (monorepo as source, generated published repositories), [TD2](TD2-component-release-policy.md)

## Problem

Each provider module exists twice: in the monorepo under `terraform/modules/<provider>/` and in a published package repository. The copies have drifted, and no rule says which one is authoritative.

Observed on 2026-10-06:

- **Cloudflare.** `artifact-pages/terraform-cloudflare-artifact-pages` contains the [ISSUE-069](../issues/ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) fix, a hostname-scoped `http_config_settings` ruleset (`unchanged_delivery`) that disables body-rewriting edge features (merge commit `80b2198`, package PR #1). Monorepo `terraform/modules/cloudflare` does not contain it. `artifact-pages/admin` consumes the package repository by git ref, so production follows the package copy.
- **AWS.** `artifact-pages/terraform-aws-artifact-pages` main (`dd0fcde`) carries the packaged 2026-10-01 line plus the AWS WAF presets (`waf.tf`, `waf-validation.tf`; [IMP-44](../implementation/IMP-44-aws-waf-custom-rules.md)), a Registry-shaped layout (`modules/`, `examples/`, `tests/`, `scripts/`, `Taskfile.yml`) and DNS/ACM composition ([IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md)). Monorepo `terraform/modules/aws` was updated on 2026-10-05 and its `main.tf` differs from the package by roughly 145 lines. Neither side is a superset of the other.

Risks: fixes land in one copy only (ISSUE-069 already did), the Registry publication of [IMP-38](../implementation/IMP-38-terraform-registry-publication.md) could ship a module missing monorepo changes, and the monorepo's local validation and the monorepo spec describe a module that production does not run.

## Options

1. **Monorepo is the source; package repositories are generated and synced.** Same model as the Action repositories ([TD14](TD14-one-repository-per-action.md)): `terraform/modules/<provider>/` is edited in the monorepo, a release job generates the Registry layout and replaces the package repository's `main`, tagging the product version. Package repositories are never edited directly.
   - For: one place for review, CI, the spec and tests; one version series ([TD2](TD2-component-release-policy.md)); the mechanism and the release App already exist.
   - Against: Registry modules usually version independently and need `examples/` and a repository-root layout, so the generator must add them; module-only fixes require a product release; the existing package-only content (WAF presets, DNS/ACM composition, examples, tests) must first be reconciled into the monorepo, a one-time merge of real divergence in both directions.
2. **Package repositories are the source; remove the monorepo copies.** The monorepo keeps only docs, examples and references to the module versions.
   - For: matches how Registry consumers and `admin` already use the modules; independent module versioning; no generator.
   - Against: the monorepo CI and local verification (T15 profiles, contract tests such as `deployment.test.js`, `routes.test.js`) lose in-tree infrastructure to test against; spec and module changes can no longer land in one PR; contradicts "source of truth for almost everything" in the workspace guidance.
3. **Keep both, add a sync check.** CI compares the two trees (normalised for layout) and fails on drift.
   - For: smallest change; no deletion.
   - Against: does not say which side wins, so each drift still needs a human decision; two review paths stay; the check needs a defined mapping that is close to writing the generator in option 1 anyway.

## Decision (2026-10-06)

Option 1. Rationale: the monorepo already owns the spec, the CLI, the local edge profiles and the release machinery, and TD14 settled the same question for Actions. A generated package repository removes the class of divergence that produced ISSUE-069 instead of detecting it; one review path, one CI and one version series ([TD2](TD2-component-release-policy.md)) cover the modules too. Options 2 and 3 are rejected: option 2 removes the in-tree infrastructure that the T15 profiles and contract tests need, and option 3 leaves two review paths and still needs the generator's mapping.

Until the reconciliation slice ([IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md)) merges, do not add features to either copy; the package repositories remain authoritative for what `admin` deploys (pin `208abf5`).

## Settled contract

1. **Source paths.** `terraform/modules/cloudflare/` and `terraform/modules/aws/` in the monorepo are the only edited copies. Callers that deploy from this repository stay under `terraform/deployments/`; they are not published. IMP-63 gives each module directory the shape of a Registry module (see 2), so that generation is a copy plus a small amount of rewriting, not a restructuring.
2. **Generated package content.** Each package repository's `main` is replaced by the generated tree, laid out as the Terraform Registry expects ([standard module structure](https://developer.hashicorp.com/terraform/language/modules/develop/structure)):
   - repository root: `README.md`, `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf`, `LICENSE` (MIT, copied from the monorepo), `.terraform.lock.hcl` only where the package already ships one for examples/tests;
   - `modules/<name>/` for nested modules (Cloudflare: `delivery`, `retention`; AWS: `cloudflare-dns-acm`), each with its own README and `.tf` files;
   - `examples/<name>/` for runnable consumers (`local-consumer`, `registry-consumer`; AWS also `cloudflare-dns-acm-consumer`);
   - `tests/` and module-level `*.tftest.hcl` files, plus the validation scripts they need;
   - `release.json` (`version`, `repository`) recording the source release, as in the Action repositories.
   Module-internal references to sibling nested modules use relative `./modules/...` paths. Examples reference the module by its Registry address with an exact `version` in the generated copy and by relative path in the monorepo copy; the generator performs that single rewrite.
3. **Never edited directly.** The package repositories carry a README note that they are generated; direct commits are overwritten by the next sync.
4. **Sync mechanism.** `release.yml` gets a job (after the existing Action sync, or beside it) that runs a generator `scripts/build-terraform-package-repos.mjs` and a sync script modelled on `scripts/sync-action-repos.sh`: replace `main` with the generated content, commit, tag, push. The token is minted from the organization App `artifact-pages-release` with `actions/create-github-app-token`, extended to the two package repositories. The App currently has Contents write only on the four Action repositories; installing it on `terraform-cloudflare-artifact-pages` and `terraform-aws-artifact-pages` is an **owner step**. A re-run with identical content is a no-op and any difference at an existing tag fails, as in TD14.
5. **Versioning.** The module tag equals the product version: `vX.Y.Z`, the same tag as the monorepo release and the Action repositories. This satisfies the Registry rules (SemVer tags, an optional `v` prefix, versions read from tags on the repository). Consequences accepted: a module-only fix needs a product patch release, and a module can receive a version bump with no content change. 0.x carries no compatibility promise (TD2).
6. **Registry addresses.** With the repositories in the `artifact-pages` organization, the Registry namespace is `artifact-pages` and the addresses become `artifact-pages/artifact-pages/cloudflare` and `artifact-pages/artifact-pages/aws` (replacing the `tasuku43/...` addresses in IMP-38). Publication itself remains IMP-38 and an owner action.
7. **Consumers.** `admin` switches from the package commit pin (`208abf5`) to the synced tag after the first synced release ([IMP-65](../implementation/IMP-65-admin-module-source-switch.md)). Until then the pin stays.
8. **ISSUE-069.** Its acceptance criteria refer to `terraform/modules/cloudflare` once IMP-63 ports `unchanged_delivery`.

## Open points

- Whether to skip tagging a package repository when its generated content is unchanged since the previous tag (proposal: tag every release for a single predictable rule; revisit if the Registry version list becomes noisy).
- Whether the lock files (`.terraform.lock.hcl`) are committed in the monorepo and copied, or generated at sync time (decide in IMP-64 once the Registry-shaped layout exists).
- How the generated examples' exact-version rewrite is verified before the tag exists (proposal: the sync job validates the generated tree with a local-source variant first; decide in IMP-64).
- Registry namespace authority and publication (IMP-38, owner).
- Whether the AWS package is advertised at the first synced release or follows the Cloudflare package (IMP-38 scope; AWS proof is not implied).

## Exit criteria

- [x] The owner chooses an option and records it here with the date (option 1, 2026-10-06).
- [x] If option 1: implementation slices cover reconciliation ([IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md)), the generator and sync ([IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md)) and the admin switch ([IMP-65](../implementation/IMP-65-admin-module-source-switch.md)); the versioning rule is recorded above; ISSUE-069's acceptance criteria refer to the surviving module (to be updated by IMP-63).
- [ ] The open points above are resolved (or consciously deferred) and the status moves to Done.
- [x] [IMP-38](../implementation/IMP-38-terraform-registry-publication.md) publication is blocked on IMP-63 to IMP-65, which the item records.
