# IMP-39 — AWS custom-domain delivery with Cloudflare DNS and ACM

- Status: In progress
- Assignee: Codex
- Phase: Provider-backed deployment / reusable distribution
- Execution: Agent-led local implementation; real-account proof is Collaborative in T15.
- Depends on: [IMP-30](IMP-30-aws-deployment-module.md) and the authoritative AWS module source prepared in [IMP-38](IMP-38-terraform-registry-publication.md).
- Related: [accepted deployment-domain policy](../../architecture/deployment-domain-policy.html), [T15](../verification/T15-provider-delivery.md), [T16](../verification/T16-external-adoption.md).
- Consumer module repository: [terraform-aws-artifact-pages](https://github.com/tasuku43/terraform-aws-artifact-pages).

## Background

The owner selected Cloudflare Registrar and authoritative Cloudflare DNS for the long-lived `artifact-pages.dev` domain. Cloudflare Cache/CDN with R2 serves production at the apex. AWS verification uses `aws.artifact-pages.stream` (moved from `aws.artifact-pages.dev` on 2026-10-03 by [TD5](../technical-design/TD5-verification-environment-and-operator-repositories.md); its DNS-only and ACM-validation records live in the separate `artifact-pages.stream` Cloudflare zone, not in the production zone) through CloudFront and private S3, with an ACM viewer certificate in `us-east-1`; no Route 53 hosted zone is used.

The original AWS module accepts caller-managed aliases and an existing certificate ARN; callers manage DNS separately. IMP-30's completed local evidence does not implement the newly selected composed Cloudflare DNS/ACM path. This is new infrastructure composition, not a duplicate review defect or reason to reopen that historical checkpoint.

## Outcome

An operator can use the AWS module's documented composition to create and validate an ACM certificate, connect its CloudFront alias through an existing Cloudflare zone, and serve the same static product contract without manually wiring DNS/certificate resources or using Route 53.

## Scope

- Implement a self-contained composed entry path in the authoritative AWS module repository using caller-configured AWS, AWS `us-east-1`, and Cloudflare provider configurations as required. Do not duplicate the AWS delivery implementation in the OSS repository.
- Consume an existing zone ID and explicit hostname. Domain purchase and authoritative-zone creation remain owner prerequisites shared by both provider deployments.
- Create the viewer certificate in `us-east-1`, manage its DNS-validation records in Cloudflare, wait for validation before attaching the alias/certificate to CloudFront, and keep validation records for certificate renewal.
- Manage the selected hostname's Cloudflare CNAME to the distribution as DNS-only. Validation records also remain DNS-only. No Cloudflare proxy/CDN belongs in the AWS browser read path.
- Preserve the existing caller-managed certificate/DNS path and default distribution-hostname path for other adopters. Do not make Cloudflare DNS part of the core product or a requirement for every AWS user.
- Document provider configuration, scoped credentials, dependencies, outputs, state ownership, import/adoption and safe certificate replacement. Do not modify apex Cloudflare delivery or unrelated DNS records.
- Add a clean caller example and local tests. DNS/certificate inputs do not enter the CLI target schema, site registry, or artifact index.

## Non-goals

- Registering the domain, owning the entire DNS zone, buying services, or applying/publishing without owner authorization.
- Route 53 resources, a second CDN in front of CloudFront, viewer identity features, Pages/Workers Static Assets, or a production GCP adapter.
- Coupling the module's version to the app bundle or changing CLI operation semantics.
- Reimplementing app deployment, site registration, site-content publication, or provider retention inside Terraform.

## Acceptance criteria

- [x] The `terraform/deployments/aws` caller selects the composed custom-domain path from the in-tree `modules/aws/modules/cloudflare-dns-acm` source without sibling OSS paths or copied delivery code.
- [ ] Tests/validation establish ACM placement in `us-east-1`, matching certificate/CloudFront alias, DNS validation before distribution attachment, and DNS-only Cloudflare CNAMEs for delivery and validation.
- [ ] The reviewed real plan contains no Route 53 hosted zone/record and no Cloudflare proxy for AWS delivery. It owns only the explicitly selected DNS records; apex and unrelated zone state remain untouched.
- [ ] Existing unmanaged-DNS/certificate and distribution-hostname callers still validate; invalid or conflicting input modes fail clearly.
- [ ] Formatting, initialization/validation, mock/offline plan or source-contract tests, and independent review pass. Provider configuration, credential names/scopes, inputs/outputs, record/certificate ownership, adoption/import, and replacement behavior are documented.
- [ ] Handoff records tested source commits and a fresh real-plan checklist for `aws.artifact-pages.stream`. Local acceptance may close this implementation item; live DNS, certificate issuance/renewal prerequisites, direct CloudFront/S3 routes, headers, and browser behavior remain unchecked T15 proof.

## Current preparation

Codex is preparing the existing AWS deployment caller to exercise the already implemented Cloudflare DNS + ACM composition. The target account is `231136241959`; both AWS provider configurations are restricted to it, and the local provider uses the named `artifact-pages-verify` SSO profile while the R2 backend retains its separate `artifact-pages-tfstate` profile and credential file. The disposable satellite role uses site ID `aws-verify`; its exact subject is `repo:artifact-pages/docs:environment:aws-verify`. The admin role subject is `repo:artifact-pages/admin:environment:aws-verify`. These dedicated GitHub environments and main-only workflow restrictions are not yet configured, so these strings do not establish OIDC isolation. The caller creates only the DNS-only `aws.artifact-pages.stream` CNAME and ACM validation records in the existing `artifact-pages.stream` zone, with ACM in `us-east-1`; Route 53 and Cloudflare proxying are excluded.

The composed path needs a Cloudflare token with `Zone > DNS > Edit` scoped to the `artifact-pages.stream` zone. It receives the existing zone ID directly, so it does not need Zone Read. The two previously configured verification tokens authenticate as active account tokens but receive HTTP 403 for read-only DNS record listing, so they cannot supply the required DNS Edit access. A dedicated verification-zone token has since been provisioned locally; read-only DNS access and a real saved plan remain pending validation. No provider write has been performed. Offline/mock validation and the saved-plan checklist are in place. T15 live AWS acceptance remains open.

## Execution and release order

Local preparation can follow AWS source packaging in the Terraform implementation thread without blocking Cloudflare's IMP-37 or first Registry publication. AWS distribution must not claim the composed custom-domain capability before this slice is verified, or real-provider support before T15 evidence. The first Cloudflare release does not wait for AWS completion.

The owner supplies account/zone inputs and credentials outside Git, reviews a real plan, and explicitly authorizes apply and cleanup. A selected hostname is not evidence of domain ownership, available credentials, certificate issuance, or successful provisioning.

## Evidence

On 2026-09-29, AWS module commit `7ed6f92` passed `mise exec terraform@1.9.8 -- ./scripts/validate.sh`: Terraform formatting, backend-free initialization and validation for the AWS module and both examples, two mocked Terraform-to-CLI contract cases, both core and wrapper account-mismatch checks, and 16/16 source-contract tests. The contract cases pass evaluated Terraform YAML to the OSS `config.Parse` function and independently verify the target account, region, effective bucket, mocked CloudFront distribution ID, and omission of preview retention and secrets. The wrapper mismatch cases separately reject a default AWS provider account mismatch and an `aws.us_east_1` account mismatch. Independent reviews found no remaining material blocker; the region remains a documented caller contract and is not auto-detected. The fresh real-plan checklist is in the module's `modules/cloudflare-dns-acm/README.md` under “Real-plan review checklist.” No real AWS or Cloudflare API calls, credentials, provider-connected plans, or applies were used. Live DNS, ACM issuance, CloudFront deployment, and browser behavior remain unverified in T15.
