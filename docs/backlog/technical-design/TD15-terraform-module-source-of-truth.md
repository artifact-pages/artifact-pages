# TD15 — Source of truth for the Terraform provider modules

- Status: Open
- Phase: Reusable distribution
- Decision: **Needs the owner's decision.** The recommendation below is a proposal only; nothing has been decided or changed.
- Related issue: [ISSUE-069](../issues/ISSUE-069-cloudflare-edge-rewrites-artifact-html.md) (its fix exists only in the package repository)
- Related implementation: [IMP-38](../implementation/IMP-38-terraform-registry-publication.md), [IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md), [IMP-44](../implementation/IMP-44-aws-waf-custom-rules.md)
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

## Recommendation (pending the owner)

Option 1. The monorepo already owns the spec, the CLI, the local edge profiles and the release machinery, and TD14 settled the same question for Actions. A generated package repository removes the class of divergence that produced ISSUE-069 instead of detecting it. Two preconditions: reconcile both package repositories back into the monorepo first (port `unchanged_delivery` and the AWS WAF/DNS-ACM work, resolving the `main.tf` differences deliberately), and decide whether Registry modules follow the product version or get their own tag series. Until the owner decides, do not edit either copy for new features, and treat the package repositories as authoritative for what `admin` deploys.

## Exit criteria

- [ ] The owner chooses an option and records it here with the date.
- [ ] If option 1: an implementation slice covers reconciliation, the generator and sync, and the Registry versioning rule; ISSUE-069's acceptance criteria refer to the surviving module.
- [ ] If option 2 or 3: the corresponding slice and the fate of `terraform/modules/*` are recorded.
- [ ] [IMP-38](../implementation/IMP-38-terraform-registry-publication.md) publication is blocked on this decision, which the item records.
