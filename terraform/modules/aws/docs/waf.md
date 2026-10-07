# Optional AWS viewer policy

`viewer_protocol_policy` is independent of WAF. Its default, `redirect-to-https`, preserves existing callers; `https-only` rejects HTTP on every CloudFront behavior. Neither setting closes CloudFront's TCP listener. HTTPS alone creates no WAF ACL or IP sets.

Choose exactly one WAF ownership mode:

- Leave `waf_custom_rules` and `web_acl_arn` null for the existing delivery behavior.
- Set `web_acl_arn` to attach a caller-owned WAFv2 global ACL in us-east-1 and the distribution's account. The module does not manage its rules.
- Set `waf_custom_rules` for one module-owned inline ACL and two stable IP sets (IPv4 and IPv6), including rules-only policies. No caller ACL may be supplied simultaneously.

All owned WAF resources use per-resource `region = "us-east-1"` and `scope = "CLOUDFRONT"`. The default AWS provider still configures S3 in `aws_region`; no additional WAF provider alias is required. The DNS/ACM wrapper forwards both inputs; its existing ACM alias is unchanged. Rules apply to the entire distribution, including aliases, the default hostname, logical and raw URLs, assets, errors, previews and cache hits. Cloudflare DNS-only records do not enforce this policy. This adds no application accounts or CLI policy fields.

## Caller example

Add these arguments to a module block using this local source (also exposed by `examples/local-consumer`). Documentation IP ranges below are examples, not a production allowlist.

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

The preset emits priority 0, `Block NOT(OR(ipv4_set, ipv6_set))`, with a custom 403 response. Allowed source IPs continue to subsequent rules. The default action is Allow. CIDRs must be strings, non-empty overall and non-/0; host bits and IPv6 spellings normalize to network CIDRs. Duplicate canonical ranges fail. Each family accepts at most 10,000 entries. An unused family is an empty set. Forwarded headers never supply the source IP for this preset.

Free rule priorities are unique integers 1..2147483647. Names are unique AWS rule names; `artifact-pages-ip-allowlist` is reserved. Allow/Block terminate evaluation, Count continues. A default Block requires an ordinary Allow rule or a group with `override_action.none`; this rejects obvious all-deny policies but cannot prove anyone will match an admission rule. Review terminating Allow rules carefully because they bypass later rules. Rate enforcement is approximate, not an exact request quota.

## Native block subset

Inputs use AWS provider snake_case block names. A singleton block is an object, repeated blocks are lists. The outer object is typed, while heterogeneous `rules`, `presets` and action unions retain raw keys for strict validation. Unknown outer typed-object attributes follow Terraform's normal conversion behavior and can be discarded; unknown members inside these raw unions are errors. Required members cannot be null; optional null members use the documented default or omit the block.

Each rule requires `name`, `priority`, `statement`, and exactly one of `action`/`override_action`. Optional `visibility_config` has boolean `cloudwatch_metrics_enabled` (default true), `sampled_requests_enabled` (false) and `metric_name`. Rule metric names default to a deterministic prefix plus name hash. ACL visibility uses the same defaults, with a prefix-based metric. Sampled requests are disabled by default; no logging resources are created.

| Statement | Members |
| --- | --- |
| `geo_match_statement` | `country_codes`: non-empty uppercase alpha-2 string list |
| `ip_set_reference_statement` | `arn`: caller-owned global IP set |
| `label_match_statement` | `key`, `scope` (`LABEL`/`NAMESPACE`) |
| `byte_match_statement` | `search_string` (1..200 UTF-8 bytes, plain text rather than base64), `positional_constraint`, field and transformations |
| `regex_match_statement` | `regex_string`, field and transformations |
| `regex_pattern_set_reference_statement` | caller-owned global `arn`, field and transformations |
| `size_constraint_statement` | integral `size`, `comparison_operator`, field and transformations |
| `sqli_match_statement` | field and transformations, optional `sensitivity_level` (`LOW`/`HIGH`) |
| `xss_match_statement` | field and transformations |
| `and_statement`, `or_statement` | `statement` list of at least two children |
| `not_statement` | one child object in `statement` |
| `rate_based_statement` | root only: integer `limit` 10..2000000000, `aggregate_key_type = "IP"`, optional `evaluation_window_sec` 60/120/300/600 (300), optional `scope_down_statement` |
| `managed_rule_group_statement` | root only: `name`, `vendor_name`, optional `version`, `scope_down_statement`, `rule_action_override` list |
| `rule_group_reference_statement` | root only: global caller-owned `arn`, optional `rule_action_override` list |

Root is level 1; child/scope-down is level 2; its child is level 3. No children below level 3, and groups/rate statements cannot nest inside boolean or scope-down statements. Referenced objects must be global/us-east-1, same account and the appropriate resource kind. AWS still validates regex/country semantics, quotas and entitlement. Referencing a newly created set/group in the same configuration is supported: resource cardinality depends on enabled mode, not validation results or unresolved ARNs.

For matching statements, `field_to_match` selects exactly one of `method = {}`, `uri_path = {}`, `query_string = {}`, `all_query_arguments = {}`, `single_header = { name = "accept" }`, or `single_query_argument = { name = "search" }`. Named fields require lowercase names. `text_transformation` is a non-empty list of `{ priority, type }` with unique nonnegative integer priorities. Types: `NONE`, `LOWERCASE`, `URL_DECODE`, `HTML_ENTITY_DECODE`, `NORMALIZE_PATH`, `COMPRESS_WHITE_SPACE`.

Ordinary `action` selects `allow = {}`, `count = {}`, or `block = {}`. Block may contain `custom_response = { response_code = 403, custom_response_body_key = "denied", response_header = [{ name = "x-denied", value = "yes" }] }`; only response_code is required. Group rules instead select `override_action = { none = {} }` or `{ count = {} }`. Group `rule_action_override` entries are `{ name = "InternalRuleName", action_to_use = { count = {} } }`, accepting the ordinary action subset. A group-wide Count override does not make every internal rule observational; use individual rule overrides when necessary.

`default_action` supports Allow or Block and the same custom response. `custom_response_bodies` maps keys to `{ content, content_type }` with `TEXT_PLAIN`, `TEXT_HTML` or `APPLICATION_JSON` content types. Every referenced key must exist; bodies are 1..10240 UTF-8 bytes. Custom responses permit integer status 200..599 and at most ten uniquely named headers; `content-type` is reserved. AWS additionally enforces aggregate quotas. Keep missing-origin-object 403→404 mapping: explicit WAF custom Block responses take precedence, but uncustomized denial can become 404. Test effective response codes on a real dedicated distribution.

Body/JSON-body inspection, multiple headers/cookies, TLS fingerprints, ASN, pre-parse transforms, forwarded IP, custom rate aggregation, CAPTCHA/Challenge, rule labels, custom request handling and managed product-specific configuration are outside the subset. Use caller-owned ACL mode for unsupported requirements. A referenced managed group may have separate charges; verify its subscription/entitlement before use. The module never enrolls one.

## Ownership, import and retirement

The whole ACL rule set is managed inline: no `rule_json`, standalone rule resources or ignored rule changes. Do not edit it out of band or adopt a Shield/FMS-controlled ACL. Before adopting a supported existing policy, inventory/back up its complete rules, sets, groups and all associated distributions. Import the ACL and both designated module-owned sets with `ID/Name/CLOUDFRONT`, mirror their configuration, then review a future no-replacement plan. For unsupported existing policies retain caller-owned mode; there is no merge-by-name or automatic import.

Both owned sets remain for the ACL's lifetime, even with the preset disabled, to avoid deleting a referenced set during preset/family changes. The ACL explicitly depends on them. WAF set/rule updates propagate separately and can temporarily refuse requests; no atomic or zero-downtime guarantee is made. Caller-owned referenced set/group removal takes two stages: remove references while keeping those objects configured, wait for the authorized update to propagate, then delete objects in their owning configuration.

The ACL has static `prevent_destroy = true`. Changing the policy to null, changing its name prefix, or otherwise replacing/deleting the ACL stops a future plan while its resource block remains present. Removing the whole module/configuration bypasses that lifecycle guard, and it does not protect unsafe in-place edits.

Managed-to-external handoff is a reviewed state/configuration operation: keep the same ARN attached, back up state/policy and inspect associations, move full ownership to the receiving state/configuration, and remove old ownership only after the receiver is complete. Do not destroy the policy during transfer or leave private content ungated. Eventual deletion requires a separately authorized retirement configuration removing the static guard, safely moving the distribution association, and deleting ACL before its sets. There is no dynamic `allow_destroy` input. Rollback uses saved inputs/policy and previous ARN with a fresh plan, authorized update and route proof; source rollback does not roll back state.

## Costs, permissions and proof

HTTPS policy has no WAF fee. Pay-as-you-go lists $5 per ACL/month, $1 per rule/month and $0.60 per million inspected requests: this allowlist plus one free rule at 1M requests is about $7.60/month before CDN/S3/logs/tax/extra WCU and managed-rule charges. IP sets have no separate listed ACL/rule fee but consume quotas. See [AWS WAF pricing](https://aws.amazon.com/waf/pricing/). CloudFront flat-rate Free/Pro plans do not support this module's existing custom cache policies; [plan limits](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html) require separate review. No subscriptions or DNS resources are created for cost optimization.

Terraform's execution identity needs WAF ACL/IP-set CRUD/tag permissions and distribution read/update/attachment permissions; reference access and exact provider API permissions need real-plan review. Publisher roles are unchanged and receive no WAF permissions. Independent read-only source review and local validation are preparation, not live enforcement proof.

Run `scripts/validate-waf.sh` for pre-plan checks, selecting a Terraform binary with `TERRAFORM_BIN` if necessary. It performs formatting checks, backend-free init, validation and pure console/source tests. It does not run Terraform plan, mocked plans, refresh, apply or provider APIs. The broader existing `scripts/validate.sh` also runs mocked plan tests and belongs to a later authorized verification step.

Before any live rollout, inventory/budget/backup, review the actual plan, authorize apply separately, and use a disposable dedicated distribution with public fixtures. Verify IPv4/IPv6 allowed/denied sources, HTTP choices, aliases/default hostname, logical/raw paths, warm/cold caches, direct-S3 refusal, missing objects, Block/default statuses, rate behavior, browser resource loading, drift detection, empty-set changes, reference removal and rollback/retirement. Record propagation and charges in T15; do not treat console or provider schema validation as those results.

The repeated native projection in `waf.tf` is generated solely at development time with `python3 scripts/generate-waf.py`, followed by `terraform fmt waf.tf`. Consumers require neither Python nor another provider. Raw-shape validation is maintained in `waf-validation.tf`.
