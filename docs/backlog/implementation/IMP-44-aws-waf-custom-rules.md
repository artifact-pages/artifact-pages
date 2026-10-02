# IMP-44 — Optional operator-configured AWS WAF custom rules

- Status: Open
- Phase: Provider-backed deployment / reusable distribution
- Primary lane: Infra
- Execution: Collaborative design first; accepted local implementation and tests are agent-led. Not assigned yet; live changes require separate owner approval.
- Module repository: `/Users/tasuku/work/github.com/tasuku43/terraform-aws-artifact-pages`
- Requires: The existing self-contained AWS CloudFront delivery module. Coordinate with [IMP-39](IMP-39-aws-cloudflare-dns-acm.md) and [IMP-38](IMP-38-terraform-registry-publication.md); neither Cloudflare WAF completion nor public Registry publication is a prerequisite to design.
- Related: [TD1](../technical-design/TD1-site-viewer-access.md), [T15](../verification/T15-provider-delivery.md), [Cloudflare counterpart](IMP-43-cloudflare-waf-custom-rules.md), [workstreams](../workstreams.md).
- Requested on: October 2, 2026 (JST).

## Background and outcome

The AWS Terraform module should accept optional operator-selected WAF custom-rule configuration through module variables for its CloudFront delivery path. The owner mentioned permitted ports as an example, but the variable schema and AWS composition are intentionally undecided.

Infrastructure remains an adapter. This does not introduce application accounts, login, per-site permissions or policy fields in CLI config/registry/artifact metadata. An operator owns the edge policy; Cloudflare DNS in the AWS composition is not the enforcement point for the direct CloudFront read path.

## Start with design

1. Inspect the authoritative AWS module and provider aliases. Verify current AWS WAF/CloudFront and Terraform-provider contracts using official documentation, including scope/region constraints, request fields, actions, rule priority, permissions and costs.
2. Assess the permitted-port example against actual CloudFront/WAF request semantics. Distinguish destination listener ports, HTTP request fields and client source ports; do not model a network firewall or promise unsupported matching.
3. Propose a minimal typed variable contract, safe no-policy default and useful examples. Compare module-managed policy with attachment of a caller-managed policy, including whether both modes are needed and how mutually exclusive inputs are validated.
4. Define ownership, association, existing-policy migration/import, updates/removal and rollback. Assess logical/raw-route coverage, default action and how unintended distribution-wide blocking is avoided.
5. Present a recommended design and unresolved security/UX choices for acceptance before implementation. Share lessons with the Cloudflare ticket without requiring identical variables or merging provider-specific implementations.

## Implementation scope after design approval

- Implement the accepted inputs/resources or attachment path in the authoritative AWS module repository; avoid maintaining another full copy in this OSS repo.
- Preserve existing callers and the caller-managed DNS/certificate path. Keep viewer filtering separate from S3 API credentials and CLI publication.
- Preserve routing, SPA fallback, real raw-object 404s, CSP, cache and static object contracts. Document region/provider aliases, costs, permissions, state ownership and rollout/rollback.
- Add caller examples, local validation and deterministic contract tests, then obtain independent review.

## Non-goals

- Live AWS applies, new charges, module publication or policy attachment without owner approval.
- Product-managed viewer identity, a general network firewall, Cloudflare implementation or mandatory WAF.
- Blocking the independent Cloudflare-first release solely to finish this AWS capability.

## Acceptance criteria

- [ ] Recommended design and variable contract are recorded and accepted before implementation; port-related capabilities and limitations are explicit and verified against provider semantics.
- [ ] An operator can configure the accepted policy through documented typed module variables; unsupported/ambiguous combinations fail clearly.
- [ ] Omitted/disabled policy preserves existing callers and delivery behavior; policy ownership and existing-association handling are explicit.
- [ ] Scope/region/provider requirements, default action, rule ordering and logical/raw-route coverage are documented and tested at the appropriate boundary.
- [ ] Local Terraform validation and deterministic tests cover enabled, disabled and invalid cases; existing module/delivery regressions pass.
- [ ] A cost/permission checklist and safe real-plan, enforcement-test and rollback procedure are documented; source/mocks are not reported as live protection.
- [ ] Independent review and actual local evidence are recorded; authorized live AWS proof remains separately tracked in T15.

## Evidence

Not started or assigned. Ticket creation does not settle the policy schema or authorize cloud operations.
