# IMP-38 — Publish provider modules through Terraform Registry

- Status: In progress
- Assignee: Codex
- Phase: Reusable distribution
- Execution: Collaborative; local packaging and release preparation are agent-led.
- Depends on: [IMP-37](IMP-37-cloudflare-entry-module.md) for the Cloudflare entry point; [T15](../verification/T15-provider-delivery.md) evidence for the provider advertised by the initial release.
- Depends on (TD15, decided 2026-10-06): [IMP-63](IMP-63-consolidate-terraform-modules.md), [IMP-64](IMP-64-generate-sync-terraform-packages.md) and [IMP-65](IMP-65-admin-module-source-switch.md). The monorepo is the module source of truth ([TD15](../technical-design/TD15-terraform-module-source-of-truth.md) option 1); the package repositories are generated on release. Registry publication starts from a synced tag, not from a hand-edited package repository.
- Related: [TD2](../technical-design/TD2-component-release-policy.md), [T16](../verification/T16-external-adoption.md), [delegation guide](../delegation.md).

## Background

Historical (pre-publication): Existing modules were consumed from repository paths pinned by Git SHA. Since 2026-10-14 both are on the Registry. The agreed next distribution route is public Terraform Registry, beginning with Cloudflare. This needs a registry-compatible provider-specific repository, an independently versioned module, and a tested consumer path; it is not covered by IMP-33's local infrastructure validation.

## Outcome

An adopter selects the Cloudflare module using a Registry `source` and an exact module version, without copying infrastructure code or checking out this OSS repository. Module releases are independent of web-app versions and Action/CLI source refs.

## Scope

- Prepare the standard module structure: an entry module at repository root, reusable nested modules, complete input/output descriptions, README, MIT license, and a runnable consumer example.
- Start with Cloudflare. Prepare AWS distribution only after its own readiness checks; do not imply that production GCP support exists. Superseded 2026-10-14: the AWS Registry module is published (0.1.0, 0.1.1); GCP is still unsupported.
- Use the owner's existing [terraform-cloudflare-artifact-pages](https://github.com/tasuku43/terraform-cloudflare-artifact-pages) and [terraform-aws-artifact-pages](https://github.com/tasuku43/terraform-aws-artifact-pages) repositories. They initially contained only `LICENSE`; the Cloudflare local checkout now contains a root entry, delivery/retention modules, examples and contract tests (observed 2026-10-01). Repository creation is already handled. Historical (2026-10-01): this did not establish pushed source, publication, or AWS package readiness; superseded by the 2026-10-14 sync line below. The intended Registry addresses were `tasuku43/artifact-pages/cloudflare` and `tasuku43/artifact-pages/aws`; superseded 2026-10-14: the published addresses are `artifact-pages/artifact-pages/cloudflare` and `artifact-pages/artifact-pages/aws`.
- Superseded by TD15: the monorepo `terraform/modules/<provider>/` is the authoritative source and the provider-module repositories are generated copies (IMP-64). The text below that speaks of authoritative package repositories is historical. Module versions are independent of the product version (TD15, 2026-10-07): each module is released by a per-module monorepo tag (`terraform-cloudflare/vX.Y.Z`, `terraform-aws/vX.Y.Z`), which creates the plain `vX.Y.Z` tag in the package repository. Record tested source commit, module release commit, tool/provider constraints, and module version together; document the migration from current OSS module paths.
- Give each published provider module its own immutable SemVer tags. Update TD2, adoption/release guides, and examples as the Registry path becomes available; existing Git-SHA examples remain valid pre-publication paths, not evidence of a Registry release.
- Prepare local package/layout/consumer validation, release checks, upgrade guidance, and the owner's initial publication checklist.
- Follow the [accepted domain policy](../../architecture/deployment-domain-policy.html) in the project's caller examples. Cloudflare production uses `artifact-pages.dev`; AWS verification uses the default CloudFront hostname with no DNS record (the `aws.artifact-pages.stream` hostname was retired on 2026-10-13); the AWS package contains the root module plus examples `local-consumer`, `registry-consumer` and `route53-consumer` (custom hostnames use `aliases` and `acm_certificate_arn`; the Cloudflare DNS/ACM composition of [IMP-39](IMP-39-aws-cloudflare-dns-acm.md) was removed 2026-10-13). It does not block the independent first Cloudflare package/publication.

## Non-goals

- Creating replacement/duplicate repositories, pushing tags, connecting Registry/GitHub accounts, or publishing without explicit owner authorization.
- Coupling module versions to web-only tags or automatically deploying the app on an infrastructure release.
- Adding a custom module registry or backend service.
- Treating a source/version rollback as an automatic Terraform state rollback.

## Acceptance criteria

- [x] The provider-specific package has a root entry module and locally resolvable nested modules; examples do not depend on sibling paths in the OSS checkout.
- [x] Local formatting, initialization/validation, package-content checks, and an isolated consumer initialization pass. README, license, input/output docs, provider constraints, and provenance are included.
- [x] The existing owner-selected repositories are populated without duplicating module source-of-truth; repository visibility and Registry namespace eligibility are verified. The owner confirms the initial version, explicitly authorizes public changes, and connects GitHub to Registry for first publication.
  - 2026-10-14: both package repositories are public with owner-set descriptions and carry tags `v0.1.0` and `v0.1.1` (synced by `release-terraform.yml`). The owner claimed the public HCP Terraform namespace `artifact-pages`, installed the "Terraform Cloud by HashiCorp" GitHub App on the org, and authorized publication (decision D9 from Trial A triage; Cloudflare first, then AWS).
- [x] The reviewed module is published with a valid immutable SemVer tag. Record the actual Registry URL, exact version, source/export commits, and publication evidence; never replace a published version's contents.
  - 2026-10-14: published as `artifact-pages/artifact-pages/cloudflare` and `artifact-pages/artifact-pages/aws` at 0.1.0 and 0.1.1 (https://registry.terraform.io/modules/artifact-pages/artifact-pages/cloudflare, https://registry.terraform.io/modules/artifact-pages/artifact-pages/aws). Package v0.1.1 tag objects: Cloudflare `cdeba891`, AWS `cf57be9c`; source tags `terraform-cloudflare/v0.1.1` and `terraform-aws/v0.1.1` on `f7096315`. See the evidence section below.
- [x] A clean external caller retrieves that exact module version through Registry and initializes/validates without copying OSS code. Record dependency resolution and the selected provider versions.
  - 2026-10-14, re-run 2026-10-17: each package's `examples/registry-consumer` at 0.1.1 ran `terraform init -backend=false` and `validate` with Terraform 1.9.8 and downloaded the module from the Registry. Providers resolved to `cloudflare/cloudflare v5.28.0` and `hashicorp/aws v6.69.1` (no lockfile, so the latest versions the constraints allow). `validate` succeeded for both.
- [x] Consumer documentation uses the real published address/version and separates module selection, plan/apply review, CLI/Action selection, and explicit app deployment. Unsupported/unpublished providers remain labeled accordingly.
  - 2026-10-17: module READMEs and registry-consumer READMEs are updated (#147). The deployment-guide gap is closed by #146 (AWS) and #169 (Cloudflare); both use the published Registry address/version and keep plan/apply and app deployment separate.
- [x] The release/check procedure covers subsequent immutable versions and independent upgrade review; module-only changes do not require a new web-app version.
  - 2026-10-17: Cloudflare `RELEASE.md` now has the post-release check (Registry lists the version, clean retrieval, evidence to T16), and #141 and #142 fixed the pipeline for second and later releases. Module-only changes need no web release.
- [ ] An independent review is completed. Registry retrieval evidence is handed to T16; deployed provider behavior remains T15 rather than being inferred from successful `terraform init`.
  - 2026-10-17: an independent review of this record is pending, and the retrieval evidence still has to be copied to T16.

## Agent preparation and user handoff

Historical (pre-publication): The agent can prepare the package, source migration/validation procedure, examples, and candidate version in the two existing repositories without waiting for Registry authorization or cloud access when that implementation work is assigned. At the handoff, present the tested commits, candidate version, package diff, and exact external actions requiring approval. Repository names are already owner-selected; the owner confirms the public release version, authorizes pushes/tag publication, and performs or authorizes the interactive account connection. No Registry publication is assumed to have occurred.

After authorization, execute only the approved publication steps and verify Registry retrieval. This ticket remains unfinished until those external acceptance criteria have evidence; local preparation alone is not Done. Cloudflare is the first live target; AWS preparation must not block the Cloudflare package or imply AWS proof. (Done 2026-10-14 for both modules; see the Registry publication evidence.)

## Evidence and references

### Registry publication — October 14, 2026

- The owner published both modules through HCP Terraform: created an HCP account and a Personal organization, installed the "Terraform Cloud by HashiCorp" GitHub App on the `artifact-pages` org, claimed the public namespace `artifact-pages`, and published both repositories. The namespace is managed only through HCP Terraform from now on.
- Addresses: `artifact-pages/artifact-pages/cloudflare` and `artifact-pages/artifact-pages/aws`. The Registry API (`/v1/modules/artifact-pages/artifact-pages/<provider>/versions`) lists `0.1.1` and `0.1.0` for both. `published_at`: Cloudflare 2026-10-14T07:23:24Z, AWS 2026-10-14T07:23:44Z.
- Package repositories `terraform-cloudflare-artifact-pages` and `terraform-aws-artifact-pages` carry `v0.1.0` and `v0.1.1`; v0.1.1 tag objects `cdeba891` (Cloudflare) and `cf57be9c` (AWS). Source tags: `terraform-cloudflare/v0.1.0` (earlier), `terraform-aws/v0.1.0` on `1455c8fd`, both `v0.1.1` on `f7096315`. Synced by `release-terraform.yml` runs 38490618299, 38498112543 and 38498112571.
- Clean retrieval (2026-10-14, re-run 2026-10-17): `examples/registry-consumer` at 0.1.1, Terraform 1.9.8, `init -backend=false` and `validate` succeeded for both; providers `cloudflare/cloudflare v5.28.0` and `hashicorp/aws v6.69.1`.
- Production consumer: admin #19 (merged as `250c892b`) switched admin production to `source = "artifact-pages/artifact-pages/cloudflare"`, `version = "0.1.1"`. `terraform init` downloaded it from the Registry; the production plan reported No changes and the lockfile was unchanged.
- Docs and procedure: #147 updated the module READMEs, registry-consumer READMEs and the Cloudflare `RELEASE.md`; #141 and #142 are the release-pipeline fixes. Deployment guides #146 (AWS) and #169 (Cloudflare) complete the address/version check. Public docs restructuring remains with Claude.
- Trial A: the trial agent hit a 404 on the documented Cloudflare address before publication and fell back to the Git source; publication fixed that.

2026-10-14: package repositories synced: `terraform-aws` v0.1.0 and v0.1.1, `terraform-cloudflare` v0.1.1 (Cloudflare v0.1.0 earlier). Registry connection and publication still need owner approval. Superseded the same day: the owner published both modules (see Registry publication above). Two release-pipeline fixes were needed for any second release: #141 (package contract tests compare the example version with `release.json`) and #142 (the workflow validates a copy, so `terraform init` symlinks never reach the sync).

October 2, 2026: local preparation, selected source integration and independent reviews are complete. Clean authoritative candidate **`208abf5eb6a7323e6161b7a798ba401dcf149c9f`** commits the reviewed registry-reader, retention-convergence and WAF changes separately; its tree is identical to the earlier tested snapshot `2daab42c7c1878d9fdbacef3d6d0db6c75b82019`. The full contract suite and exact-SHA Git consumers were rerun successfully with providers 5.26.0/5.24.0 and fixed clean CLI source `f1ed001bf0a36a382d38c7bb314c6c920b90680a`; a separate Terraform 1.5.7/provider 5.24.0 caller also initialized/validated. Packaging predecessor `611ca8ae83dd25669bbcbacea04f0ddbc4eb2aae` adds standalone package checks and publication instructions. Historical (2026-10-02): Candidate **0.1.0** is recommended but unapproved. Prior public checks found GitHub public without description and Registry versions API 404; namespace authority, pushes/tags, account connection, publication and actual Registry retrieval remain open. Superseded 2026-10-14: all of these are done (see Registry publication above). See [the preparation record](../cloudflare-module-publication-preparation.md) for commits, exact results, independent review and proposed approval steps, and [the release-proof matrix](../cloudflare-release-proof-gates.md) for advertised-scope decisions and live T15 limits. This candidate does not waive those requirements or close T15/T16.

October 1, 2026 local package preflight: clean module commit `25b6e97031a6fe5202077fe781dc4f14617b0ceb` passed Terraform 1.9.8 recursive formatting, root and local example initialization/validation, three evaluated CLI-output contracts, ten Node tests, and the isolated synthetic state-move migration with a no-change plan. A separate caller retrieved that exact commit through a local Git file URL and initialized/validated with Cloudflare 5.26.0. This is self-contained local Git package evidence, not Registry/GitHub retrieval or live infrastructure proof. Preflight repaired the validator's obsolete CLI import/helper placement; independent review found no actionable issues. The shared module checkout still has unrelated uncommitted registry-reader work, excluded from this pin. See [distribution preflight](../distribution-preflight.md) for producer source, provider resolutions and remaining owner handoffs.

Historical (2026-09-28): The owner added both public module repositories on 2026-09-28. At creation, each remote contained only `LICENSE`; the Registry did not list the Cloudflare address. Local module source and package validation are now in preparation in those repositories, but the source has not been pushed, no release tags have been published, and the Registry still does not list either module. The GitHub repository's public shell is not the same as a published module. Superseded: since 2026-10-10/14 both package repositories are generated and synced by `release-terraform.yml` (see the 2026-10-14 line above); Registry connection and publication were done on 2026-10-14 (see Registry publication above).

The [official Registry publication requirements](https://developer.hashicorp.com/terraform/registry/modules/publish) require a public GitHub repository with the module naming convention, standard structure, and at least one SemVer tag. Follow the [standard module structure](https://developer.hashicorp.com/terraform/language/modules/develop/structure) for the entry point, nested modules, examples, and documentation. Recheck these requirements at publication time.

## Remaining (reconciled 2026-10-18)

Publication and clean Registry retrieval are established above; do not republish or reconnect accounts to close this item. Remaining: independent review of this publication record and handoff of its exact 0.1.1 retrieval/tool/provider evidence to [T16](../verification/T16-external-adoption.md). That handoff is an input to clean-consumer adoption, not proof that T16 passed. IMP-64's hosted PR guard check remains separate. New tags/publications, account connections, settings changes and applies still require explicit owner approval.
