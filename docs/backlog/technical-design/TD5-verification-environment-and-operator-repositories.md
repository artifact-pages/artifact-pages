# TD5 — Verification environment and operator repositories

- Status: Done
- Phase: Reusable distribution
- Decision: On 2026-10-03 the owner decided to split the production operation of `artifact-pages.dev` into two operator repositories, one admin and one docs satellite, populated by plain copy. This repository keeps a self-contained verification environment on the separately purchased `artifact-pages.stream` domain. AWS verification moves to `aws.artifact-pages.stream`. The repositories are `tasuku43/artifact-pages-admin` and `tasuku43/artifact-pages-docs`; the names match the admin and satellite terms in the docs.
- Related design: [TD2](TD2-component-release-policy.md), [TD4](TD4-action-marketplace-distribution.md), [deployment domain policy](../../architecture/deployment-domain-policy.html)
- Related implementation: [IMP-37](../implementation/IMP-37-cloudflare-entry-module.md), [IMP-38](../implementation/IMP-38-terraform-registry-publication.md), [IMP-39](../implementation/IMP-39-aws-cloudflare-dns-acm.md), [IMP-47](../implementation/IMP-47-actions-hosted-smoke.md), [IMP-48](../implementation/IMP-48-operator-repository-split.md)
- Related verification: [T15](../verification/T15-provider-delivery.md), [T16](../verification/T16-external-adoption.md)

## Problem

This repository holds reusable packages (CLI, web bundle, composite Actions, Terraform modules) and also runs the production deployment of `artifact-pages.dev`, including its Terraform caller, deployment config and public guide and architecture sites. As a result, the production deployment never consumes released packages the way an adopter does, so it cannot serve as clean-consumer proof (T16). Moving production out, however, must not remove this repository's ability to verify its own packages end to end.

## Decisions

### Repository roles

| Repository | Role | Holds | Consumes |
| --- | --- | --- | --- |
| `tasuku43/git-artifact-pages` (this) | Packages and their verification | CLI, web, `actions/`, Terraform modules until IMP-38 moves them, fixtures, specification, backlog, verification environment | Its own working tree |
| `tasuku43/artifact-pages-admin` | Production admin for `artifact-pages.dev` | Production deployment config and registry `sites`, Terraform caller, app-deploy and registry workflows | Released CLI/Actions by exact tag; the Registry module by exact version |
| `tasuku43/artifact-pages-docs` | Satellite publishing the public sites | `guide` and `architecture` sources and shared assets, a local preview config, site-publish workflows | The released root Action by exact tag |

Content moves by plain copy; history stays in this repository. The production site IDs and URLs do not change.

### Verification domain

Cloudflare zone-level entry point rulesets are unique per phase ("Each phase has at most one entry point ruleset at the account and zone level"). A verification hostname inside the production zone would therefore share, and overwrite, production's routing, firewall, cache and response-header rulesets. A Cloudflare child zone ("subdomain setup") would avoid this but is Enterprise-only, and delegating a subdomain to another DNS provider removes Cloudflare's CDN, so R2 custom domains cannot use it. The owner purchased `artifact-pages.stream` (2026-10-03) as a separate zone that this repository's Terraform state owns exclusively.

| Hostname | Owner | Purpose |
| --- | --- | --- |
| `artifact-pages.dev` | Admin repository | Production documentation and public demonstration |
| `artifact-pages.stream` | This repository | Cloudflare verification: module changes, app deploy, publish, preview, recovery |
| `aws.artifact-pages.stream` | This repository | AWS verification. Decided 2026-10-03, replacing `aws.artifact-pages.dev` so that this repository writes no records in the production zone |

### Verification capabilities this repository keeps

- **Local:** Docker Compose with nginx and fixtures, unchanged. Verification sites come from fixtures or `examples/`, not from the moved public sites.
- **Terraform:** `terraform/deployments/cloudflare` (and `aws`) apply the working-tree modules to the verification domain, with their own state, an R2 bucket separate from production's `artifact-pages`, and their own credentials.
- **App deploy:** the working-tree CLI deploys to the verification target, by `--archive` for unreleased bundles or by its pinned release.
- **Publish:** a verification deployment config registers test sites whose `repository` is this repository and publishes them, including previews.
- **Actions:** [IMP-47](../implementation/IMP-47-actions-hosted-smoke.md) runs the composite Actions from the working tree on GitHub-hosted runners against a runner-local target. Running them against the verification domain is optional and needs scoped credentials.

## Exit criteria

- [x] Record the repository roles and the plain-copy migration.
- [x] Record the verification domain and the zone-ruleset reason.
- [x] Record the repository names (`artifact-pages-admin`, `artifact-pages-docs`).
- [x] Record the AWS verification hostname (`aws.artifact-pages.stream`), and update the deployment domain policy, specification, roadmap, IMP-38/39, T15 and delegation.
- [x] Hand the split to [IMP-48](../implementation/IMP-48-operator-repository-split.md) and the Action smoke to [IMP-47](../implementation/IMP-47-actions-hosted-smoke.md).
