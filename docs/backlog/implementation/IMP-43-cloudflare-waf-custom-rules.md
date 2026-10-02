# IMP-43 — Optional operator-configured Cloudflare WAF custom rules

- Status: Open
- Phase: Provider-backed deployment / reusable distribution
- Primary lane: Infra
- Execution: Collaborative design first; accepted local implementation and tests are agent-led. Live changes require separate owner approval.
- Module repository: `/Users/tasuku/work/github.com/tasuku43/terraform-cloudflare-artifact-pages`
- Requires: The existing self-contained Cloudflare entry module; reconcile with [IMP-37](IMP-37-cloudflare-entry-module.md) and [IMP-38](IMP-38-terraform-registry-publication.md) without waiting for public Registry publication to begin design.
- Related: [TD1](../technical-design/TD1-site-viewer-access.md), [T15](../verification/T15-provider-delivery.md), [AWS counterpart](IMP-44-aws-waf-custom-rules.md), [workstreams](../workstreams.md).
- Requested on: October 2, 2026 (JST).

## Background and outcome

An operator should be able to configure optional WAF custom rules through Terraform module variables, instead of maintaining an unrelated hand-written edge configuration. The owner mentioned permitted ports as an example; the exact conditions, variable schema, actions and resource composition have not been selected.

This is a hosting-module capability, not application-managed authorization. Artifact Pages still has no viewer accounts, login/session model, or per-site permission model. The operator owns the policy and chooses whether to enable it. Do not add these settings to CLI deployment config, site registration or artifact metadata.

## Start with design

1. Inspect the authoritative module, current provider version, delivery rules and caller examples. Consult current official Cloudflare and Terraform-provider documentation for available rule conditions, phase/action semantics, account-plan limits and permissions.
2. Clarify whether the permitted-port example means destination HTTP(S) ports, not client source ports or a general network firewall. Verify what the deployed R2/custom-domain edge can actually inspect and enforce; do not promise unsupported port filtering.
3. Propose the smallest useful typed variable interface and examples. Compare a constrained policy input with a generic custom-rule interface; decide how expressions, actions, ordering, validation and safe disabled behavior work. Do not prematurely force parity with AWS's API.
4. Resolve resource/state ownership and coexistence with existing zone rulesets, other Terraform stacks and the current routing/cache/CSP rules. Explicitly assess the blast radius beyond this application's hostname and coverage of logical and raw object routes.
5. Present a recommended design, trade-offs, costs/plan limitations and any product/UX/security decisions to the owner before implementation. Record the settled design; create a separate technical-design item only if the unresolved decision needs independent tracking.

## Implementation scope after design approval

- Implement optional module inputs and their provider-specific resources or attachment mechanism in the authoritative module repository; avoid a second independently maintained copy in the OSS repo.
- Keep the no-policy default compatible with existing callers. Document enabled/disabled behavior, accepted values, validation, rule precedence, state ownership and migration/import where necessary.
- Preserve static read paths, SPA fallback, real raw-object 404s, CSP, cache behavior and CLI origin/API publication. Distinguish edge viewer requests from authenticated R2 storage API operations.
- Include a minimal caller example and local validation/contract tests. Obtain an independent review before closing implementation.

## Non-goals

- Implementing now in the ticket-writing session, applying live WAF rules, purchasing a plan, or publishing module releases without approval.
- Product-level accounts/authorization, a general network firewall, or an AWS implementation in this ticket.
- Making WAF mandatory for existing deployments or coupling module versions to CLI/web releases.

## Acceptance criteria

- [ ] Recommended design and variable contract are recorded and accepted before implementation; the permitted-port example is either supported with verified semantics or explicitly documented as unsupported with a proposed alternative.
- [ ] An operator can configure the accepted custom-rule policy through documented typed module variables; invalid combinations fail clearly.
- [ ] Omitted/disabled policy preserves existing deployment behavior without creating unrelated WAF resources or changing existing policies.
- [ ] Hostname/path coverage, default action, ordering, zone-wide blast radius and coexistence/state ownership are documented and tested at the appropriate boundary.
- [ ] Local Terraform validation and deterministic contract tests cover enabled, disabled and invalid inputs; existing delivery/module regressions still pass.
- [ ] Provider-plan requirements, permissions and a safe real-plan/test/rollback checklist are documented. Live allow/deny enforcement is not claimed from mocks or source checks.
- [ ] Independent review and actual local evidence are recorded; any authorized real-provider proof is linked separately to T15.

## Evidence

Not started. The owner requested a separate Cloudflare design-first thread; no input schema or live change has been approved by creating this ticket.
