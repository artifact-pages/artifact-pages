# IMP-38 — Publish provider modules through Terraform Registry

- Status: In progress
- Phase: Reusable distribution
- Execution: Collaborative; local packaging and release preparation are agent-led.
- Depends on: [IMP-37](IMP-37-cloudflare-entry-module.md) for the Cloudflare entry point; [T15](../verification/T15-provider-delivery.md) evidence for the provider advertised by the initial release.
- Related: [TD2](../technical-design/TD2-component-release-policy.md), [T16](../verification/T16-external-adoption.md), [delegation guide](../delegation.md).

## Background

Existing modules are consumed from repository paths pinned by Git SHA. The agreed next distribution route is public Terraform Registry, beginning with Cloudflare. This needs a registry-compatible provider-specific repository, an independently versioned module, and a tested consumer path; it is not covered by IMP-33's local infrastructure validation.

## Outcome

An adopter selects the Cloudflare module using a Registry `source` and an exact module version, without copying infrastructure code or checking out this OSS repository. Module releases are independent of web-app versions and Action/CLI source refs.

## Scope

- Prepare the standard module structure: an entry module at repository root, reusable nested modules, complete input/output descriptions, README, MIT license, and a runnable consumer example.
- Start with Cloudflare. Prepare AWS distribution only after its own readiness checks; do not imply that an AWS Registry module or production GCP support exists.
- Use the owner's existing [terraform-cloudflare-artifact-pages](https://github.com/tasuku43/terraform-cloudflare-artifact-pages) and [terraform-aws-artifact-pages](https://github.com/tasuku43/terraform-aws-artifact-pages) repositories. They initially contained only `LICENSE`; the Cloudflare local checkout now contains a root entry, delivery/retention modules, examples and contract tests (observed 2026-10-01). Repository creation is already handled. This does not establish pushed source, publication, or AWS package readiness. The intended Registry addresses are `tasuku43/artifact-pages/cloudflare` and `tasuku43/artifact-pages/aws`; confirm actual publication/namespace availability rather than treating these addresses as live.
- Establish the provider-module repositories as the authoritative source for their independently released module implementations. Make any retained OSS infrastructure references thin pinned consumers or generated fixtures, not hand-maintained copies. Record tested source commit, module release commit, tool/provider constraints, and module version together; document the migration from current OSS module paths.
- Give each published provider module its own immutable SemVer tags. Update TD2, adoption/release guides, and examples as the Registry path becomes available; existing Git-SHA examples remain valid pre-publication paths, not evidence of a Registry release.
- Prepare local package/layout/consumer validation, release checks, upgrade guidance, and the owner's initial publication checklist.
- Follow the [accepted domain policy](../../architecture/deployment-domain-policy.html) in the project's caller examples. Cloudflare production uses `artifact-pages.dev`; AWS verification uses `aws.artifact-pages.stream` with DNS-only Cloudflare records and ACM in `us-east-1`, without Route 53. [IMP-39](IMP-39-aws-cloudflare-dns-acm.md) owns the new AWS composition; verify it before advertising that capability in an AWS module release. It does not block the independent first Cloudflare package/publication.

## Non-goals

- Creating replacement/duplicate repositories, pushing tags, connecting Registry/GitHub accounts, or publishing without explicit owner authorization.
- Coupling module versions to web-only tags or automatically deploying the app on an infrastructure release.
- Adding a custom module registry or backend service.
- Treating a source/version rollback as an automatic Terraform state rollback.

## Acceptance criteria

- [x] The provider-specific package has a root entry module and locally resolvable nested modules; examples do not depend on sibling paths in the OSS checkout.
- [x] Local formatting, initialization/validation, package-content checks, and an isolated consumer initialization pass. README, license, input/output docs, provider constraints, and provenance are included.
- [ ] The existing owner-selected repositories are populated without duplicating module source-of-truth; repository visibility and Registry namespace eligibility are verified. The owner confirms the initial version, explicitly authorizes public changes, and connects GitHub to Registry for first publication.
- [ ] The reviewed module is published with a valid immutable SemVer tag. Record the actual Registry URL, exact version, source/export commits, and publication evidence; never replace a published version's contents.
- [ ] A clean external caller retrieves that exact module version through Registry and initializes/validates without copying OSS code. Record dependency resolution and the selected provider versions.
- [ ] Consumer documentation uses the real published address/version and separates module selection, plan/apply review, CLI/Action selection, and explicit app deployment. Unsupported/unpublished providers remain labeled accordingly.
- [ ] The release/check procedure covers subsequent immutable versions and independent upgrade review; module-only changes do not require a new web-app version.
- [ ] An independent review is completed. Registry retrieval evidence is handed to T16; deployed provider behavior remains T15 rather than being inferred from successful `terraform init`.

## Agent preparation and user handoff

The agent can prepare the package, source migration/validation procedure, examples, and candidate version in the two existing repositories without waiting for Registry authorization or cloud access when that implementation work is assigned. At the handoff, present the tested commits, candidate version, package diff, and exact external actions requiring approval. Repository names are already owner-selected; the owner confirms the public release version, authorizes pushes/tag publication, and performs or authorizes the interactive account connection. No Registry publication is assumed to have occurred.

After authorization, execute only the approved publication steps and verify Registry retrieval. This ticket remains unfinished until those external acceptance criteria have evidence; local preparation alone is not Done. Cloudflare is the first live target; AWS preparation must not block the Cloudflare package or imply AWS proof.

## Evidence and references

October 2, 2026: local preparation, selected source integration and independent reviews are complete. Clean authoritative candidate **`208abf5eb6a7323e6161b7a798ba401dcf149c9f`** commits the reviewed registry-reader, retention-convergence and WAF changes separately; its tree is identical to the earlier tested snapshot `2daab42c7c1878d9fdbacef3d6d0db6c75b82019`. The full contract suite and exact-SHA Git consumers were rerun successfully with providers 5.26.0/5.24.0 and fixed clean CLI source `f1ed001bf0a36a382d38c7bb314c6c920b90680a`; a separate Terraform 1.5.7/provider 5.24.0 caller also initialized/validated. Packaging predecessor `611ca8ae83dd25669bbcbacea04f0ddbc4eb2aae` adds standalone package checks and publication instructions. Candidate **0.1.0** is recommended but unapproved. Prior public checks found GitHub public without description and Registry versions API 404; namespace authority, pushes/tags, account connection, publication and actual Registry retrieval remain open. See [the preparation record](../cloudflare-module-publication-preparation.md) for commits, exact results, independent review and proposed approval steps, and [the release-proof matrix](../cloudflare-release-proof-gates.md) for advertised-scope decisions and live T15 limits. This candidate does not waive those requirements or close T15/T16.

October 1, 2026 local package preflight: clean module commit `25b6e97031a6fe5202077fe781dc4f14617b0ceb` passed Terraform 1.9.8 recursive formatting, root and local example initialization/validation, three evaluated CLI-output contracts, ten Node tests, and the isolated synthetic state-move migration with a no-change plan. A separate caller retrieved that exact commit through a local Git file URL and initialized/validated with Cloudflare 5.26.0. This is self-contained local Git package evidence, not Registry/GitHub retrieval or live infrastructure proof. Preflight repaired the validator's obsolete CLI import/helper placement; independent review found no actionable issues. The shared module checkout still has unrelated uncommitted registry-reader work, excluded from this pin. See [distribution preflight](../distribution-preflight.md) for producer source, provider resolutions and remaining owner handoffs.

The owner added both public module repositories on 2026-09-28. At creation, each remote contained only `LICENSE`; the Registry did not list the Cloudflare address. Local module source and package validation are now in preparation in those repositories, but the source has not been pushed, no release tags have been published, and the Registry still does not list either module. The GitHub repository's public shell is not the same as a published module.

The [official Registry publication requirements](https://developer.hashicorp.com/terraform/registry/modules/publish) require a public GitHub repository with the module naming convention, standard structure, and at least one SemVer tag. Follow the [standard module structure](https://developer.hashicorp.com/terraform/language/modules/develop/structure) for the entry point, nested modules, examples, and documentation. Recheck these requirements at publication time.
