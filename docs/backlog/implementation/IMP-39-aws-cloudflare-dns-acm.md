# IMP-39 — AWS custom-domain delivery with Cloudflare DNS and ACM

- Status: Open
- Phase: Provider-backed deployment / reusable distribution
- Execution: Agent-led local implementation; real-account proof is Collaborative in T15.
- Depends on: [IMP-30](IMP-30-aws-deployment-module.md) and the authoritative AWS module source prepared in [IMP-38](IMP-38-terraform-registry-publication.md).
- Related: [accepted deployment-domain policy](../../architecture/deployment-domain-policy.html), [T15](../verification/T15-provider-delivery.md), [T16](../verification/T16-external-adoption.md).
- Consumer module repository: [terraform-aws-artifact-pages](https://github.com/tasuku43/terraform-aws-artifact-pages).

## Background

The owner selected Cloudflare Registrar and authoritative Cloudflare DNS for the long-lived `artifact-pages.dev` domain. Cloudflare Cache/CDN with R2 serves production at the apex. AWS verification uses `aws.artifact-pages.dev` through CloudFront and private S3, with an ACM viewer certificate in `us-east-1`; no Route 53 hosted zone is used.

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

- [ ] A self-contained caller can select the composed custom-domain path without sibling OSS paths, copied delivery code, or externally pre-created certificate/hostname records.
- [ ] Tests/validation establish ACM placement in `us-east-1`, matching certificate/CloudFront alias, DNS validation before distribution attachment, and DNS-only Cloudflare CNAMEs for delivery and validation.
- [ ] The plan contains no Route 53 hosted zone/record and no Cloudflare proxy for AWS delivery. It owns only the explicitly selected DNS records; apex and unrelated zone state remain untouched.
- [ ] Existing unmanaged-DNS/certificate and distribution-hostname callers still validate; invalid or conflicting input modes fail clearly.
- [ ] Formatting, initialization/validation, mock/offline plan or source-contract tests, and independent review pass. Provider configuration, credential names/scopes, inputs/outputs, record/certificate ownership, adoption/import, and replacement behavior are documented.
- [ ] Handoff records tested source commits and a fresh real-plan checklist for `aws.artifact-pages.dev`. Local acceptance may close this implementation item; live DNS, certificate issuance/renewal prerequisites, direct CloudFront/S3 routes, headers, and browser behavior remain unchecked T15 proof.

## Execution and release order

Local preparation can follow AWS source packaging in the Terraform implementation thread without blocking Cloudflare's IMP-37 or first Registry publication. AWS distribution must not claim the composed custom-domain capability before this slice is verified, or real-provider support before T15 evidence. The first Cloudflare release does not wait for AWS completion.

The owner supplies account/zone inputs and credentials outside Git, reviews a real plan, and explicitly authorizes apply and cleanup. A selected hostname is not evidence of domain ownership, available credentials, certificate issuance, or successful provisioning.

## Evidence

Not yet recorded. The owner accepted the domain policy on September 28, 2026. The previously inspected AWS interface exposes `aliases` and `acm_certificate_arn` with caller-managed DNS; live domain, ACM, Cloudflare DNS, and CloudFront behavior have not been tested by this backlog entry.
