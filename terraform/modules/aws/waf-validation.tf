# Validate raw union payloads before provider block expansion. JSON encoding is
# used only to inspect Terraform primitive types; no API JSON rule transport.
locals {
  waf_enabled = var.waf_custom_rules != null
  waf_presets = try(var.waf_custom_rules.presets, {})
  # Splat handles null without converting heterogeneous rules. Direct loops
  # preserve partial unknowns on Terraform 1.5 as well as current Terraform.
  waf_rules = flatten([for policy in var.waf_custom_rules[*] : [for i, rule in policy.rules : {
    path  = "rules[${i}](${try(tostring(rule.name), "unnamed")})"
    value = rule
  }]])
  waf_cidrs           = try(var.waf_custom_rules.presets.ip_allowlist, null)
  waf_has_allowlist   = local.waf_cidrs != null
  waf_canonical_cidrs = try([for cidr in local.waf_cidrs : "${cidrhost(cidr, 0)}/${tonumber(split("/", cidr)[1])}"], [])
  waf_family_cidrs = {
    IPV4 = sort(distinct([for cidr in local.waf_canonical_cidrs : cidr if !strcontains(cidr, ":")]))
    IPV6 = sort(distinct([for cidr in local.waf_canonical_cidrs : cidr if strcontains(cidr, ":")]))
  }
  waf_level_1 = [for r in local.waf_rules : { path = "${r.path}.statement", value = try(r.value.statement, null), level = 1 }]
  waf_level_2 = flatten([for n in local.waf_level_1 : concat(
    try([for i, v in n.value.and_statement.statement : { path = "${n.path}.and_statement.statement[${i}]", value = v, level = 2 }], []),
    try([for i, v in n.value.or_statement.statement : { path = "${n.path}.or_statement.statement[${i}]", value = v, level = 2 }], []),
    try([{ path = "${n.path}.not_statement.statement", value = n.value.not_statement.statement, level = 2 }], []),
    try(n.value.rate_based_statement.scope_down_statement == null ? [] : [{ path = "${n.path}.rate_based_statement.scope_down_statement", value = n.value.rate_based_statement.scope_down_statement, level = 2 }], []),
    try(n.value.managed_rule_group_statement.scope_down_statement == null ? [] : [{ path = "${n.path}.managed_rule_group_statement.scope_down_statement", value = n.value.managed_rule_group_statement.scope_down_statement, level = 2 }], [])
  )])
  waf_level_3 = flatten([for n in local.waf_level_2 : concat(
    try([for i, v in n.value.and_statement.statement : { path = "${n.path}.and_statement.statement[${i}]", value = v, level = 3 }], []),
    try([for i, v in n.value.or_statement.statement : { path = "${n.path}.or_statement.statement[${i}]", value = v, level = 3 }], []),
    try([{ path = "${n.path}.not_statement.statement", value = n.value.not_statement.statement, level = 3 }], [])
  )])
  waf_nodes = concat(local.waf_level_1, local.waf_level_2, local.waf_level_3)
  waf_statement_contract = {
    geo_match_statement                   = { required = ["country_codes"], optional = [] }
    ip_set_reference_statement            = { required = ["arn"], optional = [] }
    label_match_statement                 = { required = ["key", "scope"], optional = [] }
    byte_match_statement                  = { required = ["search_string", "positional_constraint", "field_to_match", "text_transformation"], optional = [] }
    regex_match_statement                 = { required = ["regex_string", "field_to_match", "text_transformation"], optional = [] }
    regex_pattern_set_reference_statement = { required = ["arn", "field_to_match", "text_transformation"], optional = [] }
    size_constraint_statement             = { required = ["size", "comparison_operator", "field_to_match", "text_transformation"], optional = [] }
    sqli_match_statement                  = { required = ["field_to_match", "text_transformation"], optional = ["sensitivity_level"] }
    xss_match_statement                   = { required = ["field_to_match", "text_transformation"], optional = [] }
    and_statement                         = { required = ["statement"], optional = [] }
    or_statement                          = { required = ["statement"], optional = [] }
    not_statement                         = { required = ["statement"], optional = [] }
    rate_based_statement                  = { required = ["aggregate_key_type", "limit"], optional = ["evaluation_window_sec", "scope_down_statement"] }
    managed_rule_group_statement          = { required = ["name", "vendor_name"], optional = ["version", "scope_down_statement", "rule_action_override"] }
    rule_group_reference_statement        = { required = ["arn"], optional = ["rule_action_override"] }
  }
  waf_payloads = flatten([for n in local.waf_nodes : try([for kind, value in n.value : {
    path = "${n.path}.${kind}", kind = kind, value = value, level = n.level
  }], [])])
  waf_fields          = [for p in local.waf_payloads : { path = "${p.path}.field_to_match", value = try(p.value.field_to_match, null) } if contains(["byte_match_statement", "regex_match_statement", "regex_pattern_set_reference_statement", "size_constraint_statement", "sqli_match_statement", "xss_match_statement"], p.kind)]
  waf_transforms      = flatten([for p in local.waf_payloads : try([for i, t in p.value.text_transformation : { path = "${p.path}.text_transformation[${i}]", value = t }], [])])
  waf_group_overrides = flatten([for p in local.waf_payloads : try([for i, v in p.value.rule_action_override : { path = "${p.path}.rule_action_override[${i}]", value = v }], [])])
  waf_actions = concat(
    local.waf_enabled ? [{ path = "default_action", value = var.waf_custom_rules.default_action, allowed = ["allow", "block"] }] : [],
    [for r in local.waf_rules : { path = "${r.path}.action", value = try(r.value.action, null), allowed = ["allow", "block", "count"] } if can(r.value.action)],
    [for r in local.waf_rules : { path = "${r.path}.override_action", value = try(r.value.override_action, null), allowed = ["none", "count"] } if can(r.value.override_action)],
    [for o in local.waf_group_overrides : { path = "${o.path}.action_to_use", value = try(o.value.action_to_use, null), allowed = ["allow", "block", "count"] }]
  )
  waf_responses = [for a in local.waf_actions : { path = "${a.path}.block.custom_response", value = try(a.value.block.custom_response, null) } if try(a.value.block.custom_response != null, false)]
  waf_headers   = flatten([for c in local.waf_responses : try([for i, h in c.value.response_header : { path = "${c.path}.response_header[${i}]", value = h }], [])])
  waf_visibility = concat(
    local.waf_enabled ? [{ path = "visibility_config", value = var.waf_custom_rules.visibility_config }] : [],
    [for r in local.waf_rules : { path = "${r.path}.visibility_config", value = r.value.visibility_config } if try(r.value.visibility_config != null, false)]
  )

  waf_shell_errors = !local.waf_enabled ? [] : concat(
    var.web_acl_arn == null ? [] : ["waf_custom_rules and web_acl_arn are mutually exclusive"],
    startswith(jsonencode(local.waf_presets), "{") && try(length(setsubtract(toset(keys(local.waf_presets)), toset(["ip_allowlist"]))) == 0, false) ? [] : ["presets: only ip_allowlist is supported"],
    startswith(jsonencode(var.waf_custom_rules.rules), "[") ? [] : ["rules: expected a list/tuple"],
    length(local.waf_rules) > 0 || local.waf_has_allowlist ? [] : ["waf_custom_rules: at least one preset or rule is required"],
    !can(var.waf_custom_rules.default_action.block) || anytrue([for r in local.waf_rules : can(r.value.action.allow) || can(r.value.override_action.none)]) ? [] : ["default_action.block: requires an Allow rule or group override_action.none; matching admission still requires operator review"],
    length(distinct([for r in local.waf_rules : try(tostring(r.value.name), "")])) == length(local.waf_rules) ? [] : ["rules: names must be unique"],
    length(distinct([for r in local.waf_rules : try(tostring(r.value.priority), "")])) == length(local.waf_rules) ? [] : ["rules: priorities must be unique"],
    alltrue([for k, b in var.waf_custom_rules.custom_response_bodies : can(regex("^[A-Za-z0-9_-]{1,128}$", k)) && contains(["TEXT_PLAIN", "TEXT_HTML", "APPLICATION_JSON"], b.content_type) && length(b.content) > 0 && length(base64encode(b.content)) * 3 / 4 - length(regexall("=", base64encode(b.content))) <= 10240]) ? [] : ["custom_response_bodies: invalid key, content type or content size (1..10240 UTF-8 bytes)"]
  )
  waf_cidr_errors = !local.waf_has_allowlist ? [] : concat(
    try(startswith(jsonencode(local.waf_cidrs), "[") && length(local.waf_cidrs) > 0 && alltrue([for c in local.waf_cidrs : startswith(jsonencode(c), "\"") && can(cidrhost(c, 0)) && tonumber(split("/", c)[1]) > 0]), false) ? [] : ["presets.ip_allowlist: expected non-empty CIDR string list; malformed CIDRs and /0 are forbidden"],
    length(local.waf_canonical_cidrs) == length(distinct(local.waf_canonical_cidrs)) ? [] : ["presets.ip_allowlist: duplicate canonical CIDRs"],
    alltrue([for addresses in local.waf_family_cidrs : length(addresses) <= 10000]) ? [] : ["presets.ip_allowlist: each IP family supports at most 10000 CIDRs"]
  )
  waf_rule_errors = flatten([for r in local.waf_rules : concat(
    try(startswith(jsonencode(r.value), "{") && length(setsubtract(toset(keys(r.value)), toset(["name", "priority", "statement", "action", "override_action", "visibility_config"]))) == 0 && alltrue([for k in ["name", "priority", "statement"] : contains(keys(r.value), k) && r.value[k] != null]), false) ? [] : ["${r.path}: invalid keys or missing required name/priority/statement"],
    try(startswith(jsonencode(r.value.name), "\"") && can(regex("^[A-Za-z0-9_-]{1,128}$", r.value.name)) && r.value.name != "artifact-pages-ip-allowlist", false) ? [] : ["${r.path}.name: expected non-reserved AWS rule name"],
    try(can(regex("^[0-9]+$", jsonencode(r.value.priority))) && r.value.priority >= 1 && r.value.priority <= 2147483647, false) ? [] : ["${r.path}.priority: expected integer 1..2147483647"],
    try((can(r.value.action) != can(r.value.override_action)) && ((can(r.value.statement.managed_rule_group_statement) || can(r.value.statement.rule_group_reference_statement)) == can(r.value.override_action)), false) ? [] : ["${r.path}: ordinary rules require action; group rules require override_action; never both"]
  )])
  waf_node_errors = flatten([for n in local.waf_nodes : try(
  startswith(jsonencode(n.value), "{") && length(keys(n.value)) == 1 && alltrue([for k in keys(n.value) : contains(keys(local.waf_statement_contract), k) && (n.level == 1 || !contains(["rate_based_statement", "managed_rule_group_statement", "rule_group_reference_statement"], k)) && (n.level < 3 || !contains(["and_statement", "or_statement", "not_statement"], k))]) ? [] : ["${n.path}: expected one supported statement; groups/rate are root-only and maximum depth is 3"], ["${n.path}: expected statement object"])])
  waf_payload_errors = flatten([for p in local.waf_payloads : concat(
    try(startswith(jsonencode(p.value), "{") && length(setsubtract(toset(keys(p.value)), toset(concat(local.waf_statement_contract[p.kind].required, local.waf_statement_contract[p.kind].optional)))) == 0 && alltrue([for k in local.waf_statement_contract[p.kind].required : contains(keys(p.value), k) && p.value[k] != null]), false) ? [] : ["${p.path}: unsupported keys or missing required members"],
    !contains(["and_statement", "or_statement"], p.kind) || try(startswith(jsonencode(p.value.statement), "[") && length(p.value.statement) >= 2, false) ? [] : ["${p.path}.statement: expected at least two children"],
    p.kind != "not_statement" || try(startswith(jsonencode(p.value.statement), "{"), false) ? [] : ["${p.path}.statement: expected one child object"],
    p.kind != "geo_match_statement" || try(startswith(jsonencode(p.value.country_codes), "[") && length(p.value.country_codes) > 0 && alltrue([for c in p.value.country_codes : startswith(jsonencode(c), "\"") && can(regex("^[A-Z]{2}$", c))]), false) ? [] : ["${p.path}.country_codes: expected non-empty uppercase country-code string list"],
    p.kind != "label_match_statement" || try(contains(["LABEL", "NAMESPACE"], p.value.scope) && can(regex("^[A-Za-z0-9_:-]+$", p.value.key)) && length(p.value.key) >= 1 && length(p.value.key) <= 1024 && startswith(jsonencode(p.value.key), "\""), false) ? [] : ["${p.path}: invalid label key/scope"],
    p.kind != "byte_match_statement" || try(startswith(jsonencode(p.value.search_string), "\"") && length(p.value.search_string) >= 1 && length(base64encode(p.value.search_string)) * 3 / 4 - length(regexall("=", base64encode(p.value.search_string))) <= 200 && contains(["EXACTLY", "STARTS_WITH", "ENDS_WITH", "CONTAINS", "CONTAINS_WORD"], p.value.positional_constraint), false) ? [] : ["${p.path}: invalid search_string (1..200 UTF-8 bytes) or positional_constraint"],
    p.kind != "regex_match_statement" || try(startswith(jsonencode(p.value.regex_string), "\"") && length(p.value.regex_string) >= 1 && length(p.value.regex_string) <= 512, false) ? [] : ["${p.path}.regex_string: expected string of 1..512 characters"],
    p.kind != "size_constraint_statement" || try(can(regex("^[0-9]+$", jsonencode(p.value.size))) && p.value.size <= 2147483647 && contains(["EQ", "NE", "LE", "LT", "GE", "GT"], p.value.comparison_operator), false) ? [] : ["${p.path}: invalid integral size or comparison_operator"],
    p.kind != "sqli_match_statement" || (try(p.value.sensitivity_level, null) == null ? true : try(contains(["LOW", "HIGH"], p.value.sensitivity_level), false)) ? [] : ["${p.path}.sensitivity_level: expected LOW or HIGH"],
    p.kind != "rate_based_statement" || try(p.value.aggregate_key_type == "IP" && can(regex("^[0-9]+$", jsonencode(p.value.limit))) && p.value.limit >= 10 && p.value.limit <= 2000000000 && contains([60, 120, 300, 600], coalesce(try(p.value.evaluation_window_sec, null), 300)) && can(regex("^[0-9]+$", jsonencode(coalesce(try(p.value.evaluation_window_sec, null), 300)))), false) ? [] : ["${p.path}: rate requires IP, integer limit 10..2000000000 and window 60/120/300/600"],
    p.kind != "managed_rule_group_statement" || try(alltrue([for k in ["name", "vendor_name"] : startswith(jsonencode(p.value[k]), "\"") && can(regex("^[A-Za-z0-9_-]{1,128}$", p.value[k]))]) && (try(p.value.version, null) == null ? true : startswith(jsonencode(p.value.version), "\"") && length(p.value.version) > 0), false) ? [] : ["${p.path}: invalid managed group name/vendor/version"],
    !contains(["rule_group_reference_statement", "managed_rule_group_statement"], p.kind) || (try(p.value.rule_action_override, null) == null ? true : try(startswith(jsonencode(p.value.rule_action_override), "[") && length(distinct([for o in p.value.rule_action_override : o.name])) == length(p.value.rule_action_override), false)) ? [] : ["${p.path}.rule_action_override: expected list with unique names"],
    !contains(["byte_match_statement", "regex_match_statement", "regex_pattern_set_reference_statement", "size_constraint_statement", "sqli_match_statement", "xss_match_statement"], p.kind) || try(startswith(jsonencode(p.value.text_transformation), "[") && length(p.value.text_transformation) > 0 && length(distinct([for t in p.value.text_transformation : t.priority])) == length(p.value.text_transformation), false) ? [] : ["${p.path}.text_transformation: expected non-empty list with unique priorities"]
  )])
  waf_field_errors = flatten([for f in local.waf_fields : try(
  startswith(jsonencode(f.value), "{") && length(keys(f.value)) == 1 && alltrue([for k, v in f.value : contains(["method", "uri_path", "query_string", "all_query_arguments", "single_header", "single_query_argument"], k) && startswith(jsonencode(v), "{") && (contains(["single_header", "single_query_argument"], k) ? try(keys(v) == ["name"] && startswith(jsonencode(v.name), "\"") && length(v.name) >= 1 && length(v.name) <= 64 && lower(v.name) == v.name, false) : length(keys(v)) == 0)]) ? [] : ["${f.path}: select one supported field; named fields require lowercase name"], ["${f.path}: invalid field object"])])
  waf_transform_errors = flatten([for t in local.waf_transforms : try(
  keys(t.value) == ["priority", "type"] && can(regex("^[0-9]+$", jsonencode(t.value.priority))) && t.value.priority <= 2147483647 && contains(["NONE", "LOWERCASE", "URL_DECODE", "HTML_ENTITY_DECODE", "NORMALIZE_PATH", "COMPRESS_WHITE_SPACE"], t.value.type) ? [] : ["${t.path}: unsupported transform or nonnegative integral priority required"], ["${t.path}: invalid transform object"])])
  waf_override_errors = flatten([for o in local.waf_group_overrides : try(
  keys(o.value) == ["action_to_use", "name"] && startswith(jsonencode(o.value.name), "\"") && can(regex("^[A-Za-z0-9_-]{1,128}$", o.value.name)) ? [] : ["${o.path}: expected name and action_to_use only"], ["${o.path}: invalid rule override"])])
  waf_action_errors = flatten([for a in local.waf_actions : try(
  startswith(jsonencode(a.value), "{") && length(keys(a.value)) == 1 && alltrue([for k, v in a.value : contains(a.allowed, k) && startswith(jsonencode(v), "{") && (k == "block" ? length(setsubtract(toset(keys(v)), toset(["custom_response"]))) == 0 : length(keys(v)) == 0)]) ? [] : ["${a.path}: expected exactly one supported action block"], ["${a.path}: invalid action object"])])
  waf_response_errors = flatten([for c in local.waf_responses : concat(
    try(startswith(jsonencode(c.value), "{") && length(setsubtract(toset(keys(c.value)), toset(["response_code", "custom_response_body_key", "response_header"]))) == 0 && can(regex("^[0-9]+$", jsonencode(c.value.response_code))) && c.value.response_code >= 200 && c.value.response_code <= 599, false) ? [] : ["${c.path}: unsupported keys or integer status 200..599 required"],
    (try(c.value.custom_response_body_key, null) == null ? true : try(startswith(jsonencode(c.value.custom_response_body_key), "\"") && contains(keys(var.waf_custom_rules.custom_response_bodies), c.value.custom_response_body_key), false)) ? [] : ["${c.path}.custom_response_body_key: must reference a configured body"],
    (try(c.value.response_header, null) == null ? true : try(startswith(jsonencode(c.value.response_header), "[") && length(c.value.response_header) <= 10 && length(distinct([for h in c.value.response_header : lower(h.name)])) == length(c.value.response_header), false)) ? [] : ["${c.path}.response_header: expected at most 10 uniquely named headers"]
  )])
  waf_header_errors = flatten([for h in local.waf_headers : try(
  keys(h.value) == ["name", "value"] && startswith(jsonencode(h.value.name), "\"") && startswith(jsonencode(h.value.value), "\"") && can(regex("^[A-Za-z0-9-]{1,256}$", h.value.name)) && lower(h.value.name) != "content-type" && length(h.value.value) >= 1 && length(h.value.value) <= 4096 ? [] : ["${h.path}: invalid response header (content-type is reserved)"], ["${h.path}: invalid response header object"])])
  waf_visibility_errors = flatten([for v in local.waf_visibility : try(
  startswith(jsonencode(v.value), "{") && length(setsubtract(toset(keys(v.value)), toset(["cloudwatch_metrics_enabled", "sampled_requests_enabled", "metric_name"]))) == 0 && alltrue([for k in ["cloudwatch_metrics_enabled", "sampled_requests_enabled"] : (try(v.value[k], null) == null ? true : contains(["true", "false"], jsonencode(v.value[k])))]) && (try(v.value.metric_name, null) == null ? true : startswith(jsonencode(v.value.metric_name), "\"") && can(regex("^[A-Za-z0-9_-]{1,128}$", v.value.metric_name)) && !contains(["All", "Default_Action"], v.value.metric_name)) ? [] : ["${v.path}: invalid keys, boolean flags or metric_name"], ["${v.path}: invalid visibility object"])])
  waf_reference_errors = flatten([for p in local.waf_payloads : !contains(["ip_set_reference_statement", "regex_pattern_set_reference_statement", "rule_group_reference_statement"], p.kind) ? [] : try(
  startswith(jsonencode(p.value.arn), "\"") && can(regex("^arn:[^:]+:wafv2:us-east-1:[0-9]{12}:global/${p.kind == "ip_set_reference_statement" ? "ipset" : p.kind == "regex_pattern_set_reference_statement" ? "regexpatternset" : "rulegroup"}/[A-Za-z0-9_-]+/[A-Za-z0-9-]+$", p.value.arn)) ? [] : ["${p.path}.arn: expected us-east-1 global ARN for this resource kind"], ["${p.path}.arn: invalid reference"])])
  waf_errors            = concat(local.waf_shell_errors, local.waf_cidr_errors, local.waf_rule_errors, local.waf_node_errors, local.waf_payload_errors, local.waf_field_errors, local.waf_transform_errors, local.waf_override_errors, local.waf_action_errors, local.waf_response_errors, local.waf_header_errors, local.waf_visibility_errors, local.waf_reference_errors)
  waf_ready             = local.waf_enabled && length(local.waf_errors) == 0
  waf_rule_values       = { for i, r in local.waf_rules : tostring(i) => r.value }
  effective_web_acl_arn = local.waf_enabled ? aws_wafv2_web_acl.viewer[0].arn : var.web_acl_arn
}

# Resource cardinality depends only on enabled mode, never validation/unknown ARNs.
# Preconditions are errors (not warning-only check assertions).
resource "terraform_data" "waf_guard" {
  input = local.waf_enabled
  lifecycle {
    precondition {
      condition     = length(local.waf_errors) == 0
      error_message = "Invalid waf_custom_rules:\n${join("\n", local.waf_errors)}"
    }
    precondition {
      condition     = (var.web_acl_arn == null ? true : split(":", var.web_acl_arn)[4] == local.aws_account_id) && alltrue([for p in local.waf_payloads : try(split(":", p.value.arn)[4] == local.aws_account_id, true)])
      error_message = "The caller-owned ACL and every referenced WAF IP/regex set or rule group must belong to the distribution's AWS account."
    }
  }
}
