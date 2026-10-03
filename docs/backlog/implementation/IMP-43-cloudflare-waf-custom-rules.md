# IMP-43 — Optional operator-configured Cloudflare WAF custom rules

- Status: Done
- Phase: Provider-backed deployment / reusable distribution
- Primary lane: Infra
- Execution: Collaborative design first; accepted local implementation and tests are agent-led. Live changes require separate owner approval.
- Module repository: `/Users/tasuku/work/github.com/tasuku43/terraform-cloudflare-artifact-pages`
- Requires: The existing self-contained Cloudflare entry module; reconcile with [IMP-37](IMP-37-cloudflare-entry-module.md) and [IMP-38](IMP-38-terraform-registry-publication.md) without waiting for public Registry publication to begin design.
- Related: [TD1](../technical-design/TD1-site-viewer-access.md), [T15](../verification/T15-provider-delivery.md), [AWS counterpart](IMP-44-aws-waf-custom-rules.md), [workstreams](../workstreams.md).
- Requested on: October 2, 2026 (JST).

## Background and outcome

An operator can configure optional Cloudflare WAF rules through the Terraform hosting module. This is operator-owned edge policy, not application-managed authorization. It does not change Site, Artifact, registry, CLI, or viewer identity contracts.

The owner accepted provider-native rules plus opt-in HTTPS-only and IP CIDR allowlist presets. All active presets combine into one hostname-scoped Block rule. This keeps the input flexible while using one custom-rule quota slot for either or both presets.

## Implementation scope

- Implement only in the authoritative module repository at `/Users/tasuku/work/github.com/tasuku43/terraform-cloudflare-artifact-pages`.
- Keep the null default compatible with existing callers. Document inputs, actions, ordering, hostname coverage, disable behavior, root ownership/import, provider permissions, and safe plan review.
- Add deterministic local contract tests and retain the existing delivery, retention, and CLI contract.
- Do not apply WAF changes, change a subscription, publish the module, implement AWS, or add authentication/Access as part of this item. Real allow/deny enforcement remains separate T15 evidence.

## Accepted contract

The design was finalized on October 2, 2026 (JST) and independently reviewed by another Luna max with no contract blocker. Actual rule conditions, permitted ports, account entitlements, and reconciliation with caller policies remain the consumer's decisions.

### Module input and rule preservation

Expose one nullable `waf_custom_rules` input with this top-level type:

```hcl
object({
  enabled = optional(bool, true)
  ruleset_name = optional(string, "Artifact Pages WAF custom rules")
  presets = optional(object({
    https_only   = optional(bool, false)
    ip_allowlist = optional(list(string)) # null/omitted disables this preset
  }), {})
  existing_rules = optional(any, []) # ordered rules from an existing phase root
  rules          = optional(any, []) # ordered provider-native rules to add
})
# variable default = null
```

Keep `rules` and `existing_rules` opaque through an `any` boundary and accept ordered list/tuple values. Do not use `list(any)` or narrow object conversions: they may coerce heterogeneous rule objects and nested `action_parameters`. Validate sequence/object shape and require non-empty string `ref`, `expression`, and `action`; require refs to be unique across preserved, generated, and caller rules. Preserve every provider-supported rule field and nested action parameter. Existing rules are copied in their original order and without expression wrapping. Supply provider-compatible configuration rather than raw API response objects; omit provider-computed IDs and timestamps.

Wrap every new rule expression with the selected lowercase public-host guard, grouping the entire caller expression so `or` cannot widen the match:

```text
(lower(http.host) eq "<lowercase public_hostname>") and (<caller expression>)
```

Do not maintain a second enum or schema for Cloudflare actions and action parameters. Pass supported caller fields through to `cloudflare_ruleset`; let the provider and Rulesets API validate action/phase compatibility, action-specific values, expression syntax, quotas, and account entitlements. The wrapper may override `expression` and effective `enabled`, but must preserve other supplied attributes.

### Presets, order, and disable behavior

- `presets.https_only = true` adds violation predicate `(not ssl or cf.edge.server_port ne 443)`. This requires an encrypted client connection on port 443; it does not create a redirect.
- `presets.ip_allowlist = ["192.0.2.10/32", "2001:db8::/128"]` adds `not ip.src in {<CIDRs>}`. Accept valid IPv4/IPv6 CIDRs, including individual `/32` and `/128` addresses. Omitted/null means no IP restriction; reject an explicit empty list, malformed or duplicate CIDRs.
- When either or both predicates are enabled, emit exactly one generated `block` rule with stable reserved ref `artifact-pages-waf-presets`. The expression is host AND the OR of enabled violation predicates. With both presets, a request is admitted only when it is HTTPS on port 443 and its source IP is in the allowlist. The generated rule uses one zone custom-rule slot.
- Rule order is `existing_rules`, optional combined preset rule, then caller `rules`. Reject caller use of the reserved ref and any duplicate ref. Later custom rules cannot undo a matching Block; earlier Skip/security policy may bypass or preempt this policy.
- Omitted/null creates no WAF resource. A non-null object must compose at least one rule. `enabled = false` keeps the root managed, disables all generated and caller rules in place, and leaves `existing_rules` unchanged. With policy enabled, each caller rule's own `enabled` value is preserved (provider default true).

Example:

```hcl
waf_custom_rules = {
  presets = {
    https_only   = true
    ip_allowlist = ["192.0.2.10/32", "2001:db8::/128"]
  }
  rules = [{
    ref         = "block-unapproved-methods"
    expression  = "http.request.method eq \"TRACE\" or ip.src.country eq \"ZZ\""
    action      = "block"
    description = "Illustrative provider-native caller rule"
  }]
}
```

The example values are placeholders, not a production policy. Validate non-empty ruleset names and rule fields, uniqueness/reserved refs, typed booleans, list/tuple structure, and final host-wrapped expressions up to Cloudflare's 4,096-character maximum. Check IP CIDRs with Terraform CIDR functions. Keep validation compatible with Terraform 1.5: input validation should only inspect its own variable; use resource preconditions for checks involving `public_hostname`.

### Resource and state ownership

Create one conditional zone ruleset in delivery with `kind = "zone"`, `phase = "http_request_firewall_custom"`, and `zone_id`. It owns the complete phase entry-point ruleset. Set static `prevent_destroy = true`; a managed-to-null/count-zero transition must produce a prevented-destroy diagnostic while the resource block remains configured. Removing the whole resource/module configuration still removes that lifecycle protection, so retirement needs an explicit state/configuration handoff.

If a phase root already exists, import it at `module.artifact_pages.module.delivery.cloudflare_ruleset.waf_custom_rules[0]` using `zones/<zone-id>/<ruleset-id>`, retain its current ruleset name, and pass every existing rule before planning an update. Only one zone entry point can own the phase, and two active states must not manage it. If another stack owns the root, leave this module input null. No account-level ruleset or separate `execute` attachment is in scope. The actual consumer lookup found no WAF phase root (404), so that consumer can create its root; this does not remove the module's generic import/preservation contract.

### Cloudflare semantics and operational boundary

The module requires Terraform `>= 1.5.0, < 2.0.0` and Cloudflare provider `>= 5.24.0, < 6.0.0`; the committed provider lock currently selects 5.26.0. Terraform optional object attributes and resource preconditions are available within that Terraform floor. The test harness currently pins Terraform 1.9.8; min-version checks must use a separate 1.5.x binary when available.

Cloudflare defines `cf.edge.server_port` as the port where its edge received the HTTP request and `ssl` as whether the client connection is encrypted. WAF blocks at layer 7; it does not close shared anycast listeners. The `http_request_transform` rewrite phase runs before custom WAF, so path-based expressions that need the original path should use `raw.http.request.uri.path` and account for normalization. Host-level presets cover logical routes, the SPA shell, assets, notices, indexes, artifacts, and previews on the configured hostname. Other hostnames, `r2.dev`, and DNS-only CloudFront delivery are outside the host guard. R2 WAF support requires a custom domain.

Provider-native actions remain caller-controlled. Block terminates evaluation, a non-match is not an allow override, Skip can bypass later security phases, Log continues and is not an access gate, and challenge pages can break SPA fetches expecting JSON. Operators must review account-level rules, previous Skip rules, redirects, action suitability, field/function availability, and quotas before deployment. Do not add a plan input that claims to prove entitlement.

Cloudflare currently documents 5/20/100/1,000 custom rules and 1/2/5/10 zone custom rulesets on Free/Pro/Business/Enterprise. Counts apply across the zone custom phase; the combined presets use one rule slot. Some actions, fields, and functions depend on plan. Root creation/update requires `Zone WAF Write` in addition to existing delivery permissions; a null input adds no WAF permission requirement. No account-level WAF resources, auth, Basic Authentication, Access application, user accounts, Workers, or secrets are part of this slice.

Official references: [Terraform WAF custom rules and permissions](https://developers.cloudflare.com/terraform/additional-configurations/waf-custom-rules/), [custom-rule quotas/actions](https://developers.cloudflare.com/waf/custom-rules/), [port condition](https://developers.cloudflare.com/waf/custom-rules/use-cases/require-specific-http-ports/), [SSL field](https://developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/ssl/), [expression limits](https://developers.cloudflare.com/ruleset-engine/rules-language/expressions/), [phase order](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/), [R2 public access](https://developers.cloudflare.com/r2/buckets/public-buckets/), [Terraform prevent_destroy behavior](https://developer.hashicorp.com/terraform/language/meta-arguments/lifecycle).

### Verification matrix and proof limits

Replace the old test asserting that the WAF resource never exists. The local suite must prove:

- null input creates no WAF resource and leaves existing delivery resources/CLI outputs unchanged;
- custom-only, HTTPS-only, IP-only, both presets, and combined presets plus custom rule composition and exact `existing → one combined preset → caller` order;
- the truth table for each preset and both presets: allowed iff `ssl && port == 443 && ip.src ∈ CIDRs` when both are enabled; the combined rule uses OR between violation predicates; every other hostname does not match;
- a caller expression containing top-level `or` stays inside the host wrapper;
- heterogeneous provider-native custom and existing rule objects, including distinct nested action-parameter shapes, preserve those fields through the root variable, module forwarding, composition locals, and mock-provider plan values;
- per-rule disable remains intact; policy disable changes only generated/caller rules; invalid sequences/objects, required strings, duplicate and reserved refs, empty root, empty/invalid/duplicate CIDRs, and over-length wrapped expressions fail clearly;
- a stateful local lifecycle plan creates a fixture, changes the WAF count to zero, and returns Terraform's prevented-destroy diagnostic; do not substitute source-text assertions for this stateful check;
- all existing module contract, delivery, retention, notice, cache/CSP, CLI output, and migration checks still pass.

Use backend-free `terraform init`/`validate`, provider-mock Terraform plan tests, and Node structural contract tests. Run the existing repository validation under Terraform 1.9.8 and verify the module with the minimum Terraform/provider versions where feasible. These local checks prove module composition and provider payload shape, not live Cloudflare expression parsing, plan entitlement, quota availability, or enforcement.

The separate authorized consumer proof is a refreshed `terraform plan` with the selected `public_hostname`, HTTPS-only, and the operator's current egress IPv4 as `/32`. Inspect that one combined Block rule is planned, no Access/auth resources appear, no unrelated resources are replaced/destroyed, and the known unrelated baseline update remains understood. Keep the actual IP in local untracked input. Do not apply. Live dry-run, controlled allow/deny requests, cache coverage, and rollback evidence belong to T15 and require separate authorization.

## Acceptance criteria

- [x] Accepted flexible variable contract and the one-rule HTTPS/IP preset composition are recorded with an independent Luna max design review.
- [x] The authoritative module implements the contract, preserves provider-native rule fields, and rejects invalid structural/preset inputs clearly.
- [x] Null/default and disabled behavior, hostname scope, rule order, existing-root preservation and state ownership are documented and locally verified.
- [x] Local validation, meaningful WAF plan/lifecycle tests and existing module regressions pass; exact results and limitations are recorded.
- [x] An independent Luna max implementation review is completed and actionable findings are resolved.
- [x] The actual consumer refreshed plan with HTTPS and the observed operator IP is recorded, with one combined preset rule and understood unrelated baseline drift; no apply is performed.
- [x] Provider permissions/entitlements and future T15 rollout/rollback checks are documented without claiming live enforcement from a plan or mocks.

## Evidence

Design investigation and official-document review were completed on October 2, 2026 (JST). The independent Luna max design review found no contract blocker. The authoritative module now implements the contract, including input validation at both the root module and directly consumable delivery-submodule boundary. Heterogeneous provider-native maps are retained through plan shaping; root and delivery provider-mock plans verify the rules and ordering, not Cloudflare's live parser or enforcement.

The full `scripts/validate.sh` was rerun successfully after all final changes. Local verification under Terraform 1.9.8 and Cloudflare provider 5.26.0 passed: root WAF tests 6/6; direct delivery WAF tests 16/16; CLI contract tests 3/3; Node contract tests 11/11; formatting and validation; and the existing module migration fixture ended with no changes after state moves. A separate stateful temporary local `terraform_data` fixture created its resource and confirmed that changing the count to zero is rejected by `prevent_destroy`. The parent task also independently checked Terraform 1.5.7 with provider 5.24.0 for the null, combined presets, heterogeneous rule attributes, policy disable, and invalid input cases. These checks do not establish live expression parsing, quotas, action availability, entitlement, or enforcement.

The independent Luna max implementation review completed with no remaining blockers or actionable findings after the null handling, heterogeneous tuple composition, and direct-delivery validation findings were resolved. The reviewer also reviewed the final consumer plan summary and found no additional issues.

The actual caller is `terraform/deployments/cloudflare`, using the sibling module checkout. Its ignored local `terraform.tfvars` enables HTTPS-only and the operator's independently observed, subsequently reconfirmed IPv4 `/32`; no address is committed to example configuration. Refreshed `init`/`validate` and `plan` completed under Terraform 1.16.4/provider 5.26.0, with detailed exit code 2: **1 add, 1 change, 0 destroy**. The only addition is `module.artifact_pages.module.delivery.cloudflare_ruleset.waf_custom_rules[0]`, with exactly one enabled Block rule (`artifact-pages-waf-presets`) combining the two violation predicates under the configured hostname. No authentication resources are added.

The remaining change is identical to the pre-feature baseline plan: retention-rule order/null-shape normalization, with expiry 86,400 seconds and multipart abort 604,800 seconds unchanged. The JSON change payload outside the WAF addition matches the baseline exactly. The existing state SHA-256 remained unchanged. Private, ignored evidence is saved under `.local/imp43-waf-plan/` (`baseline.tfplan`, `final.tfplan`, `final-plan.log`, `final-summary.json`, and `minimum-compatibility/`). The final minimum-version matrix was refreshed after the last delivery validation changes and passed again: null, heterogeneous rules, disabled policy, empty-CIDR rejection, and numeric-ref rejection.

No Cloudflare apply, live WAF mutation, AWS work, or public release occurred. The plan and mocks do not establish live enforcement or successful API writes; controlled rollout, allow/deny tests, and rollback remain T15 work.

### Post-apply retention-drift correction

After the owner applied the WAF plan, a subsequent plan reproduced the retention diff. A read-only GET confirmed that the API returned the two preview lifecycle rules in ID order, whereas configuration used the opposite order. Provider 5.26.0 also materializes omitted transition objects as empty conditions during refresh. Treating this as harmless baseline drift did not establish convergence.

The retention module now puts both actions for the same `_previews/` prefix into one `expire-preview-objects` rule and sorts all configured lifecycle rules by ID. Expiry remains 86,400 seconds and multipart abort remains 604,800 seconds for this consumer. Existing deployments require one lifecycle update to merge the old two-rule representation. No drift is ignored. The legacy abort-rule ID stays reserved.

Regression evidence: two provider-mock retention tests cover composition, additional-rule preservation and changed retention periods. The full module validation passed again (root tests 8/8 including these two, CLI 3/3, delivery 16/16, Node 11/11, lifecycle guard and migration checks). A loopback-only HTTP API fixture exercises the real provider: local fixture apply, two refreshed no-change plans, and an explicit retention-change plan. The same real-provider round-trip also passed under Terraform 1.5.7/provider 5.24.0. No fixture call reaches Cloudflare. A copied-state consumer plan refreshed against the real API shows only the required single retention update, preserving both periods and leaving WAF unchanged. The actual consumer state is locked by the owner's still-running apply process; no force-unlock or lock bypass was used, and no corrective Cloudflare apply was performed.
