# TD15 — Source of truth for the Terraform provider modules

- Status: In progress
- Phase: Reusable distribution
- Decision: The owner chose **option 1** on 2026-10-06: the monorepo is the source of truth for the Terraform modules, and the package repositories `artifact-pages/terraform-cloudflare-artifact-pages` and `artifact-pages/terraform-aws-artifact-pages` are generated and synced, like the Action repositories ([TD14](TD14-one-repository-per-action.md)). On 2026-10-07 the owner confirmed option 1 and **amended versioning**: each module has its own SemVer, independent of the product version, released by a per-module tag in the monorepo (not by a product release). See "Decision (2026-10-07)" and the "Decision history". The contract below is settled except for the points listed under "Open points", so the item stays In progress.
- Related issue: [ISSUE-069](../issues/ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) (its fix exists only in the package repository)
- Related implementation: [IMP-66](../implementation/IMP-66-per-site-control-prefix-and-aws-iam.md) (precondition for decoupled AWS releases), [IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md), [IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md), [IMP-65](../implementation/IMP-65-admin-module-source-switch.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md), [IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md), [IMP-44](../implementation/IMP-44-aws-waf-custom-rules.md)
- Related design: [TD14](TD14-one-repository-per-action.md) (monorepo as source, generated published repositories), [TD2](TD2-component-release-policy.md) (one product version; Terraform modules are a scoped exception as of 2026-10-07; the product version was later split into independent series by [TD17](TD17-config-pinned-component-versions.md))

## Problem

Each provider module exists twice: in the monorepo under `terraform/modules/<provider>/` and in a published package repository. The copies have drifted, and no rule says which one is authoritative.

Observed on 2026-10-06:

- **Cloudflare.** `artifact-pages/terraform-cloudflare-artifact-pages` contains the [ISSUE-069](../issues/ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) fix, a hostname-scoped `http_config_settings` ruleset (`unchanged_delivery`) that disables body-rewriting edge features (merge commit `80b2198`, package PR #1). Monorepo `terraform/modules/cloudflare` does not contain it. `artifact-pages/admin` consumes the package repository by git ref, so production follows the package copy.
- **AWS.** `artifact-pages/terraform-aws-artifact-pages` main (`dd0fcde`) carries the packaged 2026-10-01 line plus the AWS WAF presets (`waf.tf`, `waf-validation.tf`; [IMP-44](../implementation/IMP-44-aws-waf-custom-rules.md)), a Registry-shaped layout (`modules/`, `examples/`, `tests/`, `scripts/`, `Taskfile.yml`) and DNS/ACM composition ([IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md)). Monorepo `terraform/modules/aws` was updated on 2026-10-05 and its `main.tf` differs from the package by roughly 145 lines. Neither side is a superset of the other.

Risks: fixes land in one copy only (ISSUE-069 already did), the Registry publication of [IMP-38](../implementation/IMP-38-terraform-registry-publication.md) could ship a module missing monorepo changes, and the monorepo's local validation and the monorepo spec describe a module that production does not run.

## Options

1. **Monorepo is the source; package repositories are generated and synced.** Same model as the Action repositories ([TD14](TD14-one-repository-per-action.md)): `terraform/modules/<provider>/` is edited in the monorepo, a release job generates the Registry layout and replaces the package repository's `main`. Package repositories are never edited directly. (As first written, the job ran on the product release and tagged the product version; superseded on 2026-10-07 by a per-module tag and independent module versions, see below.)
   - For: one place for review, CI, the spec and tests; the mechanism and the release App already exist. (The first draft also listed "one version series"; replaced on 2026-10-07 by independent module versions.)
   - Against: Registry modules usually version independently and need `examples/` and a repository-root layout, so the generator must add them; module-only fixes required a product release (removed by the 2026-10-07 amendment); the existing package-only content (WAF presets, DNS/ACM composition, examples, tests) must first be reconciled into the monorepo, a one-time merge of real divergence in both directions.
2. **Package repositories are the source; remove the monorepo copies.** The monorepo keeps only docs, examples and references to the module versions.
   - For: matches how Registry consumers and `admin` already use the modules; independent module versioning; no generator.
   - Against: the monorepo CI and local verification (T15 profiles, contract tests such as `deployment.test.js`, `routes.test.js`) lose in-tree infrastructure to test against; spec and module changes can no longer land in one PR; contradicts "source of truth for almost everything" in the workspace guidance.
3. **Keep both, add a sync check.** CI compares the two trees (normalised for layout) and fails on drift.
   - For: smallest change; no deletion.
   - Against: does not say which side wins, so each drift still needs a human decision; two review paths stay; the check needs a defined mapping that is close to writing the generator in option 1 anyway.

## Decision (2026-10-06)

Option 1. Rationale: the monorepo already owns the spec, the CLI, the local edge profiles and the release machinery, and TD14 settled the same question for Actions. A generated package repository removes the class of divergence that produced ISSUE-069 instead of detecting it; one review path and one CI cover the modules too. (The 2026-10-06 text also claimed one version series; see the 2026-10-07 decision.) Options 2 and 3 are rejected: option 2 removes the in-tree infrastructure that the T15 profiles and contract tests need, and option 3 leaves two review paths and still needs the generator's mapping.

Until the reconciliation slice ([IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md)) merges, do not add features to either copy; the package repositories remain authoritative for what `admin` deploys (pin `208abf5`).

## Decision (2026-10-07)

The owner confirmed option 1 and changed the versioning rule.

1. **Keep option 1.** The monorepo is the source of truth; the package repositories are generated mirrors, like the Action repositories under [TD14](TD14-one-repository-per-action.md). Reasons: the CLI/module contract is tested in one place; moving to package-repository-as-source later is easy (stop syncing), the reverse is hard; external contributors have a single PR target, supported by a "send PRs to the monorepo" notice and auto-close in the generated repositories.
2. **Independent module versions.** Each Terraform module has its own SemVer, independent of the product version ([TD2](TD2-component-release-policy.md) carries a scoped exception; the product version has since been split into CLI, web and Action series by [TD17](TD17-config-pinned-component-versions.md)). Module releases are cut by the per-module tags `terraform-cloudflare/vX.Y.Z` and `terraform-aws/vX.Y.Z` (settled contract 5), which sync the module into its package repository and tag the plain `vX.Y.Z` there. Product releases no longer sync the Terraform packages. A module that did not change is not released and gets no version bump. This resolves the former open point on tagging unchanged content and replaces "module tag equals product version".
3. **Evidence.** Module changes rarely need to ship with CLI changes. On `origin/main` the only module commits that co-changed with CLI code are AWS IAM scope additions (`81117714`, `deabd108`, `037263f7`) that grant the publisher role access to new `_control/*` paths (site-cache, publish-state, app-cache retry); the in-flight `cli-sync-remove` change adds about 12 lines to `terraform/modules/aws/main.tf` for the same reason (`_control/preview-cleanup/*` and app-bundle delete scopes). Cloudflare had no co-changes.
4. **Precondition to decouple AWS.** New CLI control paths must no longer require module changes. Owner decision on the approach (2026-10-07): per-site control records move under `_control/sites/<site>/...`, satellite roles get only their own prefix and the admin role gets `_control/*` (exact keys and a per-site wildcard were rejected; reasons in IMP-66). This includes a CLI key-layout migration and is tracked as [IMP-66](../implementation/IMP-66-per-site-control-prefix-and-aws-iam.md). The first rollout orders module then CLI then module (IMP-66). Until it lands, an AWS module release may still be needed alongside a CLI release that adds a control path; Cloudflare is already decoupled.
5. **Compatibility.** Pinned by contract tests; README notes only for breaking contract changes (settled contract 7).

## Decision history

| Date | Decision |
| --- | --- |
| 2026-10-06 | Option 1: monorepo is the source of truth, package repositories generated and synced on product release; module tag equals product version (as an open point). |
| 2026-10-07 | Option 1 confirmed (later the same day: IMP-66 approach set to per-site control prefix `_control/sites/<site>/` with admin `_control/*`; both modules start at `0.1.0`; `release.json` records source tag and commit). Versioning changed to independent per-module SemVer with per-module monorepo tags (`terraform-cloudflare/vX.Y.Z`, `terraform-aws/vX.Y.Z`); product releases no longer sync the packages; no change means no release; generated-repository PR policy recorded; widening the AWS IAM to `_control/*` opened as IMP-66 (design check required). |

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
4. **Sync mechanism (amended 2026-10-07).** A new workflow `.github/workflows/release-terraform.yml` (separate from `release.yml`) triggers on a per-module tag (see 5), runs the generator `scripts/build-terraform-package-repos.mjs` for that one module, and a sync script modelled on `scripts/sync-action-repos.sh`: replace `main` of the matching package repository, commit, tag `vX.Y.Z`, push. The token is minted from the organization App `artifact-pages-release` with `actions/create-github-app-token`, scoped to the one package repository. The App currently has Contents write only on the four Action repositories; installing it on `terraform-cloudflare-artifact-pages` and `terraform-aws-artifact-pages` is an **owner step**. A re-run with identical content is a no-op and any difference at an existing tag fails, as in TD14. Product releases (`vX.Y.Z`) no longer touch the package repositories.
5. **Versioning (amended 2026-10-07).** Each module has its own SemVer series, independent of the product version and of the other module. A module release is cut by pushing an annotated tag in the monorepo:
   - `terraform-cloudflare/vX.Y.Z` for `terraform/modules/cloudflare`;
   - `terraform-aws/vX.Y.Z` for `terraform/modules/aws`.

   The sync then tags the package repository with the plain `vX.Y.Z` (the Registry reads SemVer tags, with optional `v`, from the package repository only). Shape rationale: (a) the prefix is `terraform-<provider>`, the same name as the package repositories, so a tag maps to its target without a lookup table; (b) it is disjoint from the product tags `v*`, so the existing `release.yml` trigger (`v*`) and the Go module version of the repository ([TD2](TD2-component-release-policy.md)) are not affected, and `terraform-*/v*` is an unambiguous trigger filter for the new workflow; (c) there is no `go.mod` under `terraform-*/`, so Go tooling ignores these tags; (d) the alternative `terraform/modules/<provider>/vX.Y.Z` mirrors the Go subdirectory-module convention but is long and implies a Go module that does not exist. A module is released only when it changed: no change, no tag, no version bump. A module-only fix needs no product release and a product release never bumps a module. The generated `release.json` records the module version and the source tag. 0.x carries no compatibility promise (same rule as [TD2](TD2-component-release-policy.md)).
6. **Registry addresses.** With the repositories in the `artifact-pages` organization, the Registry namespace is `artifact-pages` and the addresses become `artifact-pages/artifact-pages/cloudflare` and `artifact-pages/artifact-pages/aws` (replacing the `tasuku43/...` addresses in IMP-38). Publication itself remains IMP-38 and an owner action.
7. **Consumers.** `admin` switches from the package commit pin (`208abf5`) to the first synced module tag, the plain `vX.Y.Z` of the package repository (not a product tag), after the first module release ([IMP-65](../implementation/IMP-65-admin-module-source-switch.md)). Until then the pin stays.
   - **Contract with the CLI.** Compatibility between a CLI version and a module version is pinned by contract tests (`tests/cli-contract` in the package layout, run against the monorepo CLI in CI), not by version numbers. A CLI/module compatibility note appears in a module README only when a breaking contract change happens.
   - **Generated-repository PR policy.** As for the Action repositories, each package repository carries a notice that it is generated and that pull requests go to the monorepo, plus an auto-close workflow for pull requests opened against it (closed with a comment pointing to `artifact-pages/artifact-pages`). Direct commits are overwritten by the next sync.
8. **ISSUE-069.** Its acceptance criteria refer to `terraform/modules/cloudflare` once IMP-63 ports `unchanged_delivery`.

## Open points

- Resolved 2026-10-07: tagging an unchanged package. A module is released only by an explicit per-module tag and only when it changed; the sync is a no-op on identical content.
- Whether the lock files (`.terraform.lock.hcl`) are committed in the monorepo and copied, or generated at sync time (decide in IMP-64 once the Registry-shaped layout exists).
- How the generated examples' exact-version rewrite is verified before the tag exists (proposal: the sync job validates the generated tree with a local-source variant first; decide in IMP-64).
- Registry namespace authority and publication (IMP-38, owner).
- Whether the AWS package is advertised at the first synced release or follows the Cloudflare package (IMP-38 scope; AWS proof is not implied). Independent versions make a staggered start straightforward.
- Implementation of the per-site control prefix and prefix-level AWS IAM, including the CLI key-layout migration ([IMP-66](../implementation/IMP-66-per-site-control-prefix-and-aws-iam.md), after `cli-sync-remove`); until then AWS is not fully decoupled from CLI releases.
- Resolved 2026-10-07: initial versions. Both modules start at `0.1.0` (`terraform-cloudflare/v0.1.0`, `terraform-aws/v0.1.0`). The generated `release.json` records `version`, `repository`, the monorepo source tag and the source commit SHA (simplest traceable option: the sync writes what the tag already identifies).

## Exit criteria

- [x] The owner chooses an option and records it here with the date (option 1, 2026-10-06).
- [x] If option 1: implementation slices cover reconciliation ([IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md)), the generator and sync ([IMP-64](../implementation/IMP-64-generate-sync-terraform-packages.md)) and the admin switch ([IMP-65](../implementation/IMP-65-admin-module-source-switch.md)); the versioning rule is recorded above; ISSUE-069's acceptance criteria refer to the surviving module (to be updated by IMP-63).
- [x] The owner confirms option 1 and the versioning rule (2026-10-07: independent module SemVer, per-module tags).
- [ ] The open points above are resolved (or consciously deferred) and the status moves to Done.
- [x] [IMP-38](../implementation/IMP-38-terraform-registry-publication.md) publication is blocked on IMP-63 to IMP-65, which the item records.
