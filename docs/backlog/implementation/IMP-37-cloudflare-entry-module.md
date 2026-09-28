# IMP-37 — A single Cloudflare Terraform entry module

- Status: Open
- Phase: Reusable distribution
- Execution: Agent-led; live-account handoff is tracked by [T15](../verification/T15-provider-delivery.md).
- Depends on: [IMP-33](IMP-33-cloudflare-deployment.md), accepted Cloudflare mapping in [T12](../technical-design/T12-cloudflare-production-mapping.md).
- Related: [IMP-38](IMP-38-terraform-registry-publication.md), [T16](../verification/T16-external-adoption.md), [delegation guide](../delegation.md).
- Consumer module repository: [tasuku43/terraform-cloudflare-artifact-pages](https://github.com/tasuku43/terraform-cloudflare-artifact-pages), added by the owner; initial checkout contains only `LICENSE`.

## Background

The current delivery and retention modules both require an existing R2 bucket. The caller example composes them, but an adopter still creates the bucket separately and wires multiple modules. IMP-33 verified that existing-bucket contract locally; it did not provide an entry module that creates the required infrastructure. Keep its historical completion record rather than reopening it for this new scope.

## Outcome

An adopter can use one Cloudflare module declaration to create an R2 bucket and connect the accepted delivery, routing, cache, control-object denial, and preview-retention configuration. The adopter supplies the account, an existing managed DNS zone, hostname, and administrator-selected retention policy. Infrastructure stays an adapter; app deployment and registry/site publication remain separate CLI operations.

## Scope

- Provide one consumer-facing module entry point at the root of the owner's existing Cloudflare module repository, composing reusable components rather than duplicating their implementation. Keep nested-module paths self-contained; do not require a sibling OSS checkout.
- Include bucket creation, custom-domain delivery, disabled alternate `r2.dev` delivery, route/cache rules, and provider-managed preview retention.
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

- [ ] A clean root configuration invokes one entry module; its local plan includes the new bucket and required delivery/retention resources without an externally pre-created bucket.
- [ ] Bucket identity is shared across delivery and retention; validated retention agrees with the publisher's `previewRetentionDays` setting.
- [ ] Outputs provide the non-secret information needed for the existing Cloudflare deployment config; secrets remain outside committed examples and outputs.
- [ ] Source/contract tests retain logical SPA routes, real reserved-object misses, private control-object denial, cache policy, and provider-owned preview expiration. They do not stand in for live CDN evidence.
- [ ] Existing zone rules and lifecycle ownership, migration/state handling, destruction limitations, permissions, and potentially billable operations are explicit before apply. No blanket destructive defaults are introduced.
- [ ] Formatting, initialization without a backend, validation, and mock/offline plan checks pass with pinned tool/provider versions; invalid required inputs have regression coverage.
- [ ] An independent review is completed and any findings are addressed. Local evidence and the remaining live-account handoff are recorded separately.

## Agent preparation and user handoff

When assigned, the agent can implement the module, tests, example, and documentation without account credentials. If [TD3](../technical-design/TD3-preview-origin-delivery.md) changes required hostnames or trust boundaries, ask for that decision rather than folding it into this module; independent bucket/composition work can proceed.

For T15, the owner selects the account/zone/hostname, supplies credentials outside Git, and reviews the actual plan and cost before an explicitly authorized apply. T15 records live routing, isolation, cache, purge, retention, and provider-plan limitations. IMP-37 can be Done on verified local acceptance; that does not close T15, prove free-plan compatibility, or authorize public deployment.

## Evidence

Not yet recorded. Current existing-bucket source and local plan evidence belongs to IMP-33, not this new entry point.
