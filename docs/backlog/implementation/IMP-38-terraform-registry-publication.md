# IMP-38 — Publish provider modules through Terraform Registry

- Status: Open
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
- Use the owner's existing [terraform-cloudflare-artifact-pages](https://github.com/tasuku43/terraform-cloudflare-artifact-pages) and [terraform-aws-artifact-pages](https://github.com/tasuku43/terraform-aws-artifact-pages) repositories. Both local checkouts contain only `LICENSE` and point to those GitHub remotes as of 2026-09-28; they contain no module yet. Repository creation is already handled. The intended Registry addresses are `tasuku43/artifact-pages/cloudflare` and `tasuku43/artifact-pages/aws`; confirm actual publication/namespace availability rather than treating these addresses as live.
- Establish the provider-module repositories as the authoritative source for their independently released module implementations. Make any retained OSS infrastructure references thin pinned consumers or generated fixtures, not hand-maintained copies. Record tested source commit, module release commit, tool/provider constraints, and module version together; document the migration from current OSS module paths.
- Give each published provider module its own immutable SemVer tags. Update TD2, adoption/release guides, and examples as the Registry path becomes available; existing Git-SHA examples remain valid pre-publication paths, not evidence of a Registry release.
- Prepare local package/layout/consumer validation, release checks, upgrade guidance, and the owner's initial publication checklist.
- Follow the [accepted domain policy](../../architecture/deployment-domain-policy.html) in the project's caller examples. Cloudflare production uses `artifact-pages.dev`; AWS verification uses `aws.artifact-pages.dev` with DNS-only Cloudflare records and ACM in `us-east-1`, without Route 53. [IMP-39](IMP-39-aws-cloudflare-dns-acm.md) owns the new AWS composition; verify it before advertising that capability in an AWS module release. It does not block the independent first Cloudflare package/publication.

## Non-goals

- Creating replacement/duplicate repositories, pushing tags, connecting Registry/GitHub accounts, or publishing without explicit owner authorization.
- Coupling module versions to web-only tags or automatically deploying the app on an infrastructure release.
- Adding a custom module registry or backend service.
- Treating a source/version rollback as an automatic Terraform state rollback.

## Acceptance criteria

- [ ] The provider-specific package has a root entry module and locally resolvable nested modules; examples do not depend on sibling paths in the OSS checkout.
- [ ] Local formatting, initialization/validation, package-content checks, and an isolated consumer initialization pass. README, license, input/output docs, provider constraints, and provenance are included.
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

The owner added both module repositories on 2026-09-28. Read-only inspection confirms clean `main` checkouts with their matching GitHub `origin` URLs and `LICENSE` as the only visible file. No Terraform source, module package validation, release tag publication, or Registry listing is evidenced by that initial state. No files in those repositories were changed while creating this backlog.

The [official Registry publication requirements](https://developer.hashicorp.com/terraform/registry/modules/publish) require a public GitHub repository with the module naming convention, standard structure, and at least one SemVer tag. Follow the [standard module structure](https://developer.hashicorp.com/terraform/language/modules/develop/structure) for the entry point, nested modules, examples, and documentation. Recheck these requirements at publication time.
