# IMP-37 — A single Cloudflare Terraform entry module

- Status: In progress
- Phase: Reusable distribution
- Execution: Agent-led; live-account handoff is tracked by [T15](../verification/T15-provider-delivery.md).
- Depends on: [IMP-33](IMP-33-cloudflare-deployment.md), accepted Cloudflare mapping in [T12](../technical-design/T12-cloudflare-production-mapping.md).
- Related: [IMP-38](IMP-38-terraform-registry-publication.md), [T16](../verification/T16-external-adoption.md), [delegation guide](../delegation.md).
- Consumer module repository: [tasuku43/terraform-cloudflare-artifact-pages](https://github.com/tasuku43/terraform-cloudflare-artifact-pages), added by the owner; initial checkout contains only `LICENSE`.

## Background

The current delivery and retention modules both require an existing R2 bucket. The caller example composes them, but an adopter still creates the bucket separately and wires multiple modules. IMP-33 verified that existing-bucket contract locally; it did not provide an entry module that creates the required infrastructure. Keep its historical completion record rather than reopening it for this new scope.

## Outcome

An adopter can use one Cloudflare module declaration to create an R2 bucket and connect the accepted delivery, routing, cache, catch-all app-shell rewrite, and preview-retention configuration. The adopter supplies the account, an existing managed DNS zone, hostname, and administrator-selected retention policy. The default bucket name is `artifact-pages` within the account, with an explicit override available; availability is not guaranteed. Infrastructure stays an adapter; app deployment, site registration, and site-content publication remain separate CLI operations.

For the project's first real deployment, the owner selected `artifact-pages.dev` as the long-lived production hostname with Cloudflare Registrar and authoritative DNS, using Cache/CDN + R2 rather than Pages or Workers Static Assets. Consume the owner-provisioned zone and connect only the selected custom domain; do not purchase the domain or duplicate zone ownership. This is a configurable operator deployment, not a hard-coded module hostname. The [accepted domain policy](../../architecture/deployment-domain-policy.html) separates it from the DNS-only AWS verification hostname; acquisition and live proof remain T15.

## Scope

- Provide one consumer-facing module entry point at the root of the owner's existing Cloudflare module repository, composing reusable components rather than duplicating their implementation. Keep nested-module paths self-contained; do not require a sibling OSS checkout.
- Include bucket creation, custom-domain delivery, route/cache rules, and provider-managed preview retention. Leave `r2.dev` unmanaged and rely on Cloudflare's disabled-by-default state for a newly created private bucket.
- Document required inputs, validations, supported Terraform/provider versions, and non-secret outputs that map to the existing deployment config.
- Document ownership of the complete zone phase-root rulesets and bucket lifecycle policy. Preserve the existing rules/import guidance; do not overwrite unrelated zone rules silently.
- Provide a minimal clean-caller example and local validation/contract tests. Keep any existing-bucket path clearly separate from the new-bucket example.
- Retain the existing lower-level modules for their current use cases. A new entry point must not imply that moving existing Terraform resources between module addresses is automatically safe.

## Non-goals

- Buying a domain, creating a Cloudflare account, or managing viewer identity/access policy.
- Minting/distributing publisher credentials, deploying the web bundle, or publishing site content from Terraform.
- Adding Workers, a request-time backend, a production GCP module, or a new preview origin by implication.
- Applying to a live account or publishing to Terraform Registry within this implementation slice.

## Acceptance criteria

- [ ] A clean root configuration invokes one entry module; its local plan includes the new bucket and required delivery/retention resources without an externally pre-created bucket. Omitting `bucket_name` selects `artifact-pages`; an explicit override is used as supplied, and a name collision fails without random fallback.
- [ ] Bucket identity is shared across delivery and retention. `preview_retention_days` controls Terraform lifecycle only and is not duplicated in the CLI deployment config.
- [ ] Outputs provide the non-secret information needed for the existing Cloudflare deployment config; secrets remain outside committed examples and outputs.
- [ ] Source/contract tests retain logical SPA routes, explicit content-path origin behavior, catch-all rewrites (including `/_control/*`) to `/index.html`, cache policy, and provider-owned preview expiration. They do not stand in for live CDN evidence.
- [ ] Existing zone rules and lifecycle ownership, migration/state handling, destruction limitations, permissions, and potentially billable operations are explicit before apply. Existing-bucket callers are instructed to disable `r2.dev` separately because it bypasses custom-host rewrites. No blanket destructive defaults are introduced.
- [ ] Formatting, initialization without a backend, validation, and mock/offline plan checks pass with pinned tool/provider versions; invalid required inputs have regression coverage.
- [ ] An independent review is completed and any findings are addressed. Local evidence and the remaining live-account handoff are recorded separately.

## Agent preparation and user handoff

When assigned, the agent can implement the module, tests, example, and documentation without account credentials. If [TD3](../technical-design/TD3-preview-origin-delivery.md) changes required hostnames or trust boundaries, ask for that decision rather than folding it into this module; independent bucket/composition work can proceed.

For T15, the owner selects the account/zone/hostname, supplies credentials outside Git, and reviews the actual plan and cost before an explicitly authorized apply. T15 records live routing, isolation, cache, purge, retention, and provider-plan limitations. IMP-37 can be Done on verified local acceptance; that does not close T15, prove free-plan compatibility, or authorize public deployment.

## Evidence

On 2026-09-29, Cloudflare module commits `0ca5eea` and `98e046c` passed `mise exec terraform@1.9.8 -- ./scripts/validate.sh`: Terraform formatting, backend-free initialization and validation for the module and local consumer, all three mocked Terraform-to-CLI contract cases, 8/8 source-contract tests, and the local-only `terraform_data` module-address migration fixture with a no-change plan after state moves. The contract cases pass evaluated Terraform YAML to the OSS `config.Parse` function and verify the default bucket, explicit bucket override, custom credential environment-variable names, and omission of default environment names, secrets, and Terraform-only retention. Independent review found no remaining material blocker; its output-description and lockfile notes were addressed. No Cloudflare credentials or provider API calls were used. Live account, DNS, custom-domain, and content-delivery proof remain in T15.
