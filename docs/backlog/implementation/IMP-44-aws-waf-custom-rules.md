# IMP-44 — Optional operator-configured AWS WAF custom rules

- Status: In progress
- Phase: Provider-backed deployment / reusable distribution
- Primary lane: Infra
- Execution: Design accepted and local implementation authorized on October 2, 2026, through the pre-plan boundary. Agent-led local checks only; Terraform plan (including mocked plans), live changes and publication require further authorization.
- Module repository: `/Users/tasuku/work/github.com/tasuku43/terraform-aws-artifact-pages`
- Requires: The existing self-contained AWS CloudFront delivery module. Coordinate with [IMP-39](IMP-39-aws-cloudflare-dns-acm.md) and [IMP-38](IMP-38-terraform-registry-publication.md); neither Cloudflare WAF completion nor public Registry publication is a prerequisite to design.
- Related: [TD1](../technical-design/TD1-site-viewer-access.md), [T15](../verification/T15-provider-delivery.md), [Cloudflare counterpart](IMP-43-cloudflare-waf-custom-rules.md), [workstreams](../workstreams.md).
- Requested on: October 2, 2026 (JST).

## Background and outcome

The AWS Terraform module should accept optional operator-selected WAF custom-rule configuration through module variables for its CloudFront delivery path. The owner mentioned permitted ports as an example, but the variable schema and AWS composition are intentionally undecided.

Design priority: choose the least expensive, simplest configuration that actually satisfies the operator's requirements. Start from the required behavior, not from WAF resources. Prefer standard CloudFront or other already-required infrastructure capabilities wherever they provide equivalent enforcement; introduce paid WAF resources only for requirements those capabilities cannot meet. Compare recurring charges, request-based costs and operational overhead, with assumptions and limitations made explicit. Do not weaken the required protection to reduce cost.

For example, evaluate HTTPS-only viewer access through CloudFront Viewer Protocol Policy rather than a WAF custom rule. Distinguish rejecting HTTP from redirecting HTTP to HTTPS, and confirm the desired behavior before selecting the policy. Verify current official provider semantics and costs during design; this example does not settle all edge-policy inputs.

Infrastructure remains an adapter. This does not introduce application accounts, login, per-site permissions or policy fields in CLI config/registry/artifact metadata. An operator owns the edge policy; Cloudflare DNS in the AWS composition is not the enforcement point for the direct CloudFront read path.

## Start with design

1. Inspect the authoritative AWS module and provider aliases. Map each requested behavior to standard infrastructure capabilities first, then identify any remaining need for WAF. Verify current AWS WAF/CloudFront and Terraform-provider contracts using official documentation, including scope/region constraints, request fields, actions, rule priority, permissions and costs.
2. Assess the permitted-port example against actual CloudFront/WAF request semantics. Distinguish destination listener ports, HTTP request fields and client source ports; do not model a network firewall or promise unsupported matching.
3. Compare the lowest-cost requirement-complete alternatives and recommend a minimal typed variable contract, safe defaults and useful examples. Only where WAF is needed, compare module-managed policy with attachment of a caller-managed policy, including whether both modes are needed and how mutually exclusive inputs are validated. A standard-feature-only configuration must not require a WAF ACL or paid custom rules.
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

- [x] Recommended design and variable contract are recorded and accepted before implementation; port-related capabilities and limitations are explicit and verified against provider semantics.
- [x] Each requirement is mapped to its enforcement mechanism. The recommended configuration minimizes cost and complexity without weakening requirements; standard features are preferred, and any additional WAF charges have an explicit justification. HTTPS-only behavior is evaluated through Viewer Protocol Policy, with reject-versus-redirect behavior documented.
- [ ] An operator can configure the accepted policy through documented typed module variables; unsupported/ambiguous combinations fail clearly.
- [ ] Omitted/disabled policy preserves existing callers and delivery behavior; policy ownership and existing-association handling are explicit.
- [ ] Scope/region/provider requirements, default action, rule ordering and logical/raw-route coverage are documented and tested at the appropriate boundary.
- [ ] Local Terraform validation and deterministic tests cover enabled, disabled and invalid cases; existing module/delivery regressions pass.
- [ ] A cost/permission checklist and safe real-plan, enforcement-test and rollback procedure are documented; source/mocks are not reported as live protection.
- [x] Independent review and actual local evidence are recorded; authorized live AWS proof remains separately tracked in T15.

## Evidence

Design investigation started on October 2, 2026 (JST). The owner subsequently approved proceeding with implementation through the pre-plan boundary. Terraform plan, cloud operations and publication are outside that authorization.

## Accepted contract — provider-native blocks (pre-plan implementation)

The owner selected presets plus free rules following AWS semantics, with provider-standard rule blocks rather than JSON transport. HTTPS-only stays outside WAF. This contract supersedes earlier ARN-only and API-JSON candidates. The owner approved implementing it locally through the pre-plan boundary.

### Inputs and example

Retain `web_acl_arn = null` as the alternative caller-owned ACL mode. Add independent `viewer_protocol_policy` (`string`, non-null, default `redirect-to-https`; allow only that or `https-only`) and apply it to every behavior. HTTP redirect and HTTP rejection remain separate choices; neither closes a TCP listener. No port-list or `presets.https_only` input is proposed.

Proposed nullable `waf_custom_rules` shell:

```hcl
object({
  default_action = optional(any, { allow = {} })
  presets        = optional(any, {})
  rules          = optional(any, [])
  custom_response_bodies = optional(map(object({
    content      = string
    content_type = string
  })), {})
  visibility_config = optional(object({
    cloudwatch_metrics_enabled = optional(bool, true)
    sampled_requests_enabled   = optional(bool, false)
    metric_name                = optional(string)
  }), {})
})
# variable default = null
```

`any` is restricted to provider-shaped heterogeneous unions; it is not an unvalidated escape hatch. Preserve raw rule, preset and action keys for validation before projecting them into blocks. The outer typed shell has normal Terraform object-conversion behavior; do not claim it rejects every unknown outer attribute. Rule and preset payloads must reject unknown keys at every supported node. No `list(any)` coercion, JSON transport, expression language or external validation executable is introduced.

`presets` accepts only `{ ip_allowlist = list(string) }`, with null/omitted `ip_allowlist` disabling that preset. `rules` accepts a list/tuple of objects with required `name`, integral `priority`, `statement`, exactly one of `action` / `override_action`, and optional `visibility_config`. The rule-level visibility object has the same three fields/defaults as above; omitted metric names derive deterministically from the module prefix and rule-name hash, within AWS limits. Omitted/null optional values are normalized deliberately; required values cannot be null. Preserve names as stable rule identities; list ordering does not replace numeric WAF priorities.

Illustrative caller (reserved documentation IPs; not a production policy):

```hcl
viewer_protocol_policy = "https-only"
waf_custom_rules = {
  presets = {
    ip_allowlist = ["192.0.2.10/32", "2001:db8::/128"]
  }
  rules = [{
    name     = "limit-viewer-rate"
    priority = 100
    statement = {
      rate_based_statement = {
        aggregate_key_type    = "IP"
        limit                 = 2000
        evaluation_window_sec = 300
      }
    }
    action = { block = { custom_response = { response_code = 403 } } }
  }]
}
```

The HTTPS choice operates independently when WAF is null. Rate limits are approximate AWS enforcement, not an exact quota. The example denies unlisted IPs before evaluating the rate rule and uses an explicit WAF Block response to preserve denial status independently of the origin 403 mapping. Policy values require operator selection before any live use.

### Supported rule contract

Use provider snake_case keys. Singleton blocks are singleton objects; repeated blocks are lists of objects. Validate the raw shape before expansion. This is a documented initial subset of the provider, not a promise to support every current/future AWS WAF option.

| Statement | Accepted members / boundaries |
| --- | --- |
| `geo_match_statement` | `country_codes` (non-empty list of ISO alpha-2 strings); actual countries validated by AWS. Source IP only. |
| `ip_set_reference_statement` | `arn` of caller-owned CLOUDFRONT/us-east-1 IP set in the same account. No forwarded-IP config. |
| `label_match_statement` | `scope` (`LABEL` or `NAMESPACE`), `key`. |
| `byte_match_statement` | UTF-8 `search_string`, provider `positional_constraint`, `field_to_match`, `text_transformation`. No base64 encoding by the caller. |
| `regex_match_statement` | `regex_string`, `field_to_match`, `text_transformation`; AWS validates regex semantics. |
| `regex_pattern_set_reference_statement` | Same-account global `arn`, `field_to_match`, `text_transformation`. Set ownership stays with caller. |
| `size_constraint_statement` | `comparison_operator`, integral `size`, `field_to_match`, `text_transformation`. |
| `sqli_match_statement` | `field_to_match`, `text_transformation`, optional `sensitivity_level` (`LOW`/`HIGH`). |
| `xss_match_statement` | `field_to_match`, `text_transformation`. |
| `and_statement`, `or_statement` | `statement` list, at least two children. |
| `not_statement` | Exactly one child object in `statement`. |
| `rate_based_statement` | Root only: integral `limit`, `aggregate_key_type = "IP"`, optional `evaluation_window_sec` (60/120/300/600, default 300), optional `scope_down_statement`. No forwarded IP/custom aggregation. |
| `managed_rule_group_statement` | Root only: `name`, `vendor_name`, optional `version`, `scope_down_statement`, and `rule_action_override` list of `{name, action_to_use}`. No `managed_rule_group_configs` or paid product-specific configs. |
| `rule_group_reference_statement` | Root only: global same-account `arn`, optional `rule_action_override` list. No ownership of the group. |

For the initial module contract define root statement as level 1, child/scope-down as level 2, its child as level 3. No children below level 3. Thus at most two logical wrappers; rate/group statements may not appear inside boolean or scope-down children. This conservative ceiling fits the provider's documented three levels; actual emitted blocks must be checked against the floor/current schema. Generated preset NOT → OR → IP references also fits this ceiling.

For string/regex/size/SQLi/XSS statements, `field_to_match` supports exactly one of `method = {}`, `uri_path = {}`, `query_string = {}`, `all_query_arguments = {}`, `single_header = {name = ...}`, or `single_query_argument = {name = ...}`. Names for these two named fields must be lowercase to avoid round-trip diffs. `text_transformation` is a non-empty list of `{priority, type}` with unique nonnegative integral priorities. Supported `type` initially: `NONE`, `LOWERCASE`, `URL_DECODE`, `HTML_ENTITY_DECODE`, `NORMALIZE_PATH`, `COMPRESS_WHITE_SPACE`. Unknown transforms fail with a supported-values diagnostic; expand this finite contract only with an example/test, not silently. Body/JSON-body, multi-header/cookies, TLS fingerprints, ASN, pre-parse transforms, custom rate keys, CAPTCHA/Challenge, rule labels and paid managed-rule configs are outside this initial subset. These needs can use caller-owned ACL mode until intentionally added.

Ordinary rules use exactly one `action` member: `allow = {}`, `count = {}`, or `block = {}`. Block may contain `custom_response` with required HTTP `response_code`, optional `custom_response_body_key`, and optional `response_header` list of `{name,value}`. Group references instead use exactly one `override_action` member (`none = {}` or `count = {}`); ordinary action is invalid there. Per-group `action_to_use` accepts the same ordinary-action subset. Default action accepts `allow = {}` or `block = { ... }`, including the same custom response shape. The module does not convert a group override into Count observation of every internal rule; use explicit per-rule overrides when needed.

Each referenced custom body key must exist in `custom_response_bodies`; content types are `TEXT_PLAIN`, `TEXT_HTML`, `APPLICATION_JSON`. Enforce the AWS/provider content-size/header/status limits, resource name/metric limits and one-action constraints at local validation/provider boundary; AWS syntax, quotas, availability and entitlement remain API validation. JSON_BODY detection is not implied by accepting an APPLICATION_JSON response body. Fixed module-owned name derives from `name_prefix`; avoid adding an independent replacement-prone ACL name input.

These shapes draw on the [provider 6.0 ACL schema](https://github.com/hashicorp/terraform-provider-aws/blob/v6.0.0/website/docs/r/wafv2_web_acl.html.markdown), [current provider schema](https://github.com/hashicorp/terraform-provider-aws/blob/v6.66.0/internal/service/wafv2/schemas.go), [AWS rule actions](https://docs.aws.amazon.com/waf/latest/APIReference/API_Rule.html), and [rate statement](https://docs.aws.amazon.com/waf/latest/APIReference/API_RateBasedStatement.html). Source examples are not runtime proof.

### Preset, validation and ordering

Create a reserved `artifact-pages-ip-allowlist` rule at priority 0: Block NOT(OR(module IPv4 set, module IPv6 set)), with a status-only custom 403 response. CIDRs use the actual source IP, never a forwarded header. Allowed IPs continue to later free rules. Free priorities must be unique integers 1..2147483647, names unique/non-reserved and valid AWS rule names. Default Allow is recommended; explicit default Block requires at least one ordinary Allow rule or a group using `override_action.none`. This guard rejects obvious preset/Count/Block-only accidental all-deny configurations but cannot prove an Allow will match or a group will admit anyone; operator review/live proof remains required. Terminating Allow can bypass later filters for admitted IPs, so order is security-relevant.

CIDR input must be a non-empty list of actual strings; reject malformed values and `/0` (AWS limitation). Canonicalize using the network address from Terraform CIDR functions plus the parsed prefix, normalize IPv6 textual form, then sort/deduplicate per family; reject duplicates after normalization rather than silently widening/rewriting policy intent. Canonical output may differ textually from the supplied CIDR but represents the same range. Bound each family to AWS's IP-set capacity. The empty managed family set is allowed, but an empty overall allowlist input is not.

Validate each statement node has one recognized kind; each payload has only its specified members, with actual JSON primitive/object/array types checked before Terraform coercion. Missing required/unsupported fields and too-deep statements must stop the plan, identifying rule name and field path. Validate IP/regex/group ARN region/scope/account with plan-stopping resource preconditions. Terraform 1.5 variable validations inspect only that variable; cross-input/account/response-key checks use resource preconditions, not warning-only `check` blocks. Unknown values stay unknown until resolvable; no fail-open fallback.

A non-null configuration must compose at least one free rule or preset. Reject simultaneous module-owned config and `web_acl_arn`. No global `enabled` flag: retain an observation policy with explicit Count settings when appropriate; null is removal, not observation. Do not stage private-content protection by temporarily allowing everyone.

### Resource composition, provider compatibility and state

Recommend **one inline-rule `aws_wafv2_web_acl` with full rule ownership**, no `rule_json`, standalone rule resources or `ignore_changes = [rule]`. Newer provider docs recommend standalone resources for deletion/diff issues, but standalone Read finds named rules only and preserves outside rules during updates. That is weaker than complete ACL ownership. Inline Read collects the rule set (except provider-handled Shield mitigation rules); actual no-op/update/drift behavior must be tested. No Shield/FMS-controlled policy adoption is in scope. Evidence: [ACL source](https://github.com/hashicorp/terraform-provider-aws/blob/v6.66.0/internal/service/wafv2/web_acl.go), [standalone source](https://github.com/hashicorp/terraform-provider-aws/blob/v6.66.0/internal/service/wafv2/web_acl_rule.go).

Maintain two stable module-owned IP sets, IPv4 and IPv6, for the lifetime of each module-owned ACL, including rules-only policies. Unused sets have `addresses = []`. This adds two small state resources even for a free-rule-only ACL but avoids deletion/recreation when disabling a preset or changing families. The ACL explicitly depends on both sets even when no preset is emitted; preset references always use both. Empty sets are supported by the [IP-set API](https://docs.aws.amazon.com/waf/latest/APIReference/API_CreateIPSet.html) and [provider](https://github.com/hashicorp/terraform-provider-aws/blob/v6.0.0/website/docs/r/wafv2_ip_set.html.markdown). Addresses and rule updates propagate separately; temporary refusal is possible, so this is not atomic or a zero-downtime guarantee.

All three resources use `scope = "CLOUDFRONT"`, explicit per-resource `region = "us-east-1"`, same default AWS provider/account as the distribution. Per-resource region exists in provider 6.0; retain `~> 6.0` and Terraform `>= 1.5.0`, with implementation validation at both the floor and locked 6.66. No new root provider alias is mandatory. S3 remains at `aws_region`; ACM wrapper's existing `aws.us_east_1` stays independent. Add WAF/protocol input forwarding to the DNS/ACM wrapper. No Cloudflare edge, Route 53 or CLI schema changes.

Attach the effective ARN via distribution `web_acl_id`, never regional AssociateWebACL. The distribution explicitly depends on the complete managed policy. Omitted config creates no ACL or sets and preserves caller-managed ARN attachment. No lookup/import by name, no second state owning the same resources, no automatic rule merge. For adoption, inventory/back up the complete policy, referenced objects and all associated distributions; import ACL and both designated sets with `ID/Name/CLOUDFRONT`, mirror full supported configuration, then review a no-replacement plan. Leave unsupported/existing externally managed policies in caller-owned mode.

Static `prevent_destroy = true` on the module ACL blocks null/count-zero transitions and replacement while the resource block remains present. It cannot stop unsafe in-place rule edits or protect removal of the entire module/resource configuration. The guard is deliberately stronger than a convenient disable flag. Retirement or managed↔external handoff requires an explicit reviewed state/configuration procedure: keep the same ARN attached during transfer, never leave a private-content distribution ungated, remove the old owner only after the new state/configuration is complete. Eventual deletion requires an authorized retirement configuration that removes the guard, safely moves association, then destroys ACL before its sets. Do not invent `allow_destroy` as a dynamic lifecycle variable.

Inline rules still need a **two-stage removal of caller-owned referenced IP/regex sets or groups**: first update the ACL to remove/replace references while keeping those objects in their owning configuration; after apply/propagation, plan their deletion separately. No module resource can promise one-apply safety for external object deletion. Source rollback is not state rollback. Rollback uses saved inputs/policy and previous ARN, fresh plan, authorized update and route proof.

### Delivery, costs, permissions and future verification

Policy is distribution-wide: all aliases/default CloudFront hostname, logical shell/routes, assets/notices/bridge, raw indexes/artifacts/previews, errors and cache hits. No product login/per-site authorization, CLI/registry/artifact policy fields or identity-based caches. `_control` bytes stay private/unrouted. DNS-only Cloudflare does not enforce this AWS boundary. Path rules must account for both logical and raw routes; no implicit hostname wrapper is added.

Keep origin 403→404 mapping for missing private-S3 objects. Explicit WAF Block custom responses take precedence over CloudFront custom errors; default denial without customization may map to 404. Preserve protected-byte denial rather than claiming every rejection is 403. Live test this interaction including default action. See [WAF/CloudFront errors](https://docs.aws.amazon.com/waf/latest/developerguide/cloudfront-waf-use-cases.html) and [HTTPS policy](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-https-viewers-to-cloudfront.html).

Protocol controls incur no separate WAF fee. A pay-as-you-go ACL with one rule and 1M inspected requests is about $6.60/month ($5 ACL + $1 rule + $0.60 requests); this preset plus one free rule is about $7.60. Standard IP sets have no separate listed ACL/rule fee, but consume quotas and operations. CDN/S3/logging/tax and higher WCU/body/paid-rule charges are additional. No logging resource is added; sampled requests default false, CloudWatch metrics default true. Operators may separately configure logging with suitable redaction/retention. [WAF prices](https://aws.amazon.com/waf/pricing/).

Free/Pro flat-rate plans are not equivalent to the current custom cache policies. Business ($200/month) is the first published custom-cache tier; do not alter cache contracts or create Route 53/enroll a subscription to obtain cheaper WAF. Plan eligibility, required retained ACL association and cancellation constraints need separate owner review. [Flat-rate limits](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html), [prices](https://aws.amazon.com/cloudfront/pricing/).

Terraform execution identity needs narrowly scoped WAF ACL/IP-set read/create/update/delete/tag permissions plus distribution read/update/attachment permissions; referenced-set read/entitlement and actual provider API calls need verification. Publisher roles receive no edge permissions. Disabled callers gain no cloud lookup/WAF resources. Live plans, apply, new paid resources, enrollment, tagging/publication/pushes remain separately authorized.

After approval: verify every listed field/depth/action/default/preset in both Terraform 1.5/provider 6.0 and the current 1.9.8/6.66 harness; preserve existing routing/cache/CSP/control/CLI regressions. Add deterministic invalid-key/type/depth/ARN/exclusive-mode cases, mixed IPv4/IPv6 canonical duplicates and `/0`, generated rule order, custom responses, no-resource defaults, prevent-destroy diagnostics and explicit IP-set dependency/retirement ordering. Mock plans do not prove drift or AWS propagation. Obtain independent implementation review.

T15 live proof uses an explicitly approved disposable dedicated distribution/policy: inventory/back up state/policy/associations/budget, review real plan then approve apply; test allowed/denied IPv4/IPv6, HTTP protocol choices, alternate/default host, logical/raw paths, warm/cold caches, direct S3 refusal, object 404s, effective Block/default responses, rate behavior, resource/header/browser behavior and rollback. Demonstrate named-rule drift and out-of-band added-rule detection, empty-set updates and reference removal/delete order. Record propagation and charges separately; Count staging uses public fixtures only. Do not modify retained preview lifecycle experiments.

### Evidence and execution boundary

Authoritative source inspected at `7f4d16ed83f52cee43854a1e183298e3f3ad3b9c`; AWS checkout unchanged. Both repository guidance and thesis/specification/roadmap, TD1, IMP-38/39/43, deployment policy/workstreams/delegation were read. Prior independent reviews established source/cost boundaries and rejected raw JSON drift/field-drop claims. Final read-only independent review of this concrete proposal found no blocking inconsistencies in the schema, finite projection/depth, action/default guards, stable dual-family sets, dependencies or guarded retirement. Provider schema checks, runtime drift and AWS propagation remain future verification; review is not implementation or live protection evidence.

The owner accepted this concrete direction and authorized implementation through the pre-plan boundary. The ticket remains In progress because evaluated plans and later delivery proof are not established. No Terraform plan, mocked plan, refresh, apply, cloud resource operations, paid resources, tags, pushes or publication are authorized by this step.


### Pre-plan implementation evidence — October 2, 2026

Implemented locally in the authoritative AWS module (uncommitted): optional `waf_custom_rules`, independent protocol input, root/wrapper/local-consumer forwarding, whole inline ACL with static destroy guard, stable IPv4/IPv6 sets, raw-shape/ordering/action/CIDR/response/reference validation, provider-native generated block projection, examples and `docs/waf.md`. The generated projection requires no runtime generator or extra provider; reproduction from `scripts/generate-waf.py` followed by fmt was byte-identical. Publisher IAM, CLI output, routing/cache/CSP and DNS contracts were preserved.

Final checks:

- Terraform 1.9.8 / locked AWS provider 6.66.0: `TERRAFORM_BIN=<1.9.8 binary> scripts/validate-waf.sh` passed fmt, backend-free readonly-lock initialization and validation of root plus both local consumers, then **89/89** console/source tests. Output: module `.local/waf-preplan-results.txt`.
- Terraform 1.5.7 / AWS provider 6.0.0: backend-free init and root validation passed in an isolated temporary source copy constrained to exactly 6.0.0; `TERRAFORM_BIN=<1.5.7 binary> node --test tests/aws-contract.test.js tests/waf-console.test.js` passed **89/89**. Output copied to module `.local/waf-floor-results.txt`. The original module lock remains unchanged. Floor wrapper validation is not claimed.
- `git diff --check` passed. Pure console fixtures used temporary state paths; no existing caller state was read or changed.
- Final independent read-only source review found no remaining blocking findings. Corrections included separating resource cardinality from unknown validation results, preserving native partially-known rule structure on Terraform 1.5, validating caller-owned ACL ARNs/account, and using UTF-8 byte limits for search/response strings.

The 89 tests comprise 16 existing source/routing/browser-policy contracts and 73 WAF console/source cases, including null/default mode, all supported statement kinds and fields, heterogeneous rules/group overrides, a computed caller reference without a plan, canonical CIDRs, malformed/unknown keys and types, ordering/default guards, response bodies/headers, protocol/ARN diagnostics and byte limits. They do not evaluate provider resource changes or lifecycle preconditions in a plan. Scalar malformed containers may stop Terraform expansion before the detailed guard; they never silently disable WAF.

This completes the authorized pre-plan slice. **No Terraform plan (real or mocked), refresh, apply, state migration/import, cloud resource operation, subscription, paid resource creation, push, tag or publication was performed.** The broader script's mocked account/CLI plans were deliberately not executed at this boundary. Evaluated native blocks, actual plan-stopping preconditions, account guards, drift/no-op/update behavior and retirement ordering remain for the next authorized plan stage; live delivery/propagation/cost/rollback proof remains in T15. Ticket remains In progress rather than claiming the whole implementation acceptance criteria are established.
