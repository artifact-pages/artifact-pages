locals {
  normalized_path = "lower(url_decode(http.request.uri.path, \"r\"))"
  host_match      = "lower(http.host) eq \"${lower(var.public_hostname)}\""

  reserved_path_exclusions = join(" and ", [
    "${local.normalized_path} ne \"/index.html\"",
    "${local.normalized_path} ne \"/preview-bridge.js\"",
    "${local.normalized_path} ne \"/license\"",
    "${local.normalized_path} ne \"/third_party_notices.txt\"",
    "${local.normalized_path} ne \"/assets\"",
    "not starts_with(${local.normalized_path}, \"/assets/\")",
    "${local.normalized_path} ne \"/_indexes\"",
    "not starts_with(${local.normalized_path}, \"/_indexes/\")",
    "${local.normalized_path} ne \"/_artifacts\"",
    "not starts_with(${local.normalized_path}, \"/_artifacts/\")",
    "${local.normalized_path} ne \"/_previews\"",
    "not starts_with(${local.normalized_path}, \"/_previews/\")",
  ])

  waf_presets_active = try(var.waf_custom_rules.presets.https_only, false) || try(var.waf_custom_rules.presets.ip_allowlist != null, false)

  waf_preset_violations = compact([
    try(var.waf_custom_rules.presets.https_only, false) ? "not ssl or cf.edge.server_port ne 443" : "",
    try(var.waf_custom_rules.presets.ip_allowlist, null) != null ? "not ip.src in {${join(" ", try(var.waf_custom_rules.presets.ip_allowlist, []))}}" : "",
  ])

  waf_preset_rule = local.waf_presets_active ? [{
    ref         = "artifact-pages-waf-presets"
    description = "Block requests to this hostname that violate the enabled access presets."
    expression  = "(${local.host_match}) and (${join(" or ", [for predicate in local.waf_preset_violations : "(${predicate})"])})"
    action      = "block"
    enabled     = var.waf_custom_rules.enabled
  }] : []

  waf_caller_rules = [
    for rule in try(var.waf_custom_rules.rules, []) : merge(rule, {
      expression = "(${local.host_match}) and (${rule.expression})"
      enabled    = try(var.waf_custom_rules.enabled, false) && (try(rule.enabled, true) != false)
    })
  ]

  waf_ruleset_name = try(var.waf_custom_rules.ruleset_name, "Artifact Pages WAF custom rules")

  waf_composed_rules = concat(
    try(var.waf_custom_rules.existing_rules, []),
    local.waf_preset_rule,
    local.waf_caller_rules,
  )

  waf_composed_refs = [for rule in local.waf_composed_rules : rule.ref]

  waf_final_expression_lengths = concat(
    [for rule in local.waf_preset_rule : length(rule.expression)],
    [for rule in local.waf_caller_rules : length(rule.expression)],
  )

  logical_route_rule = {
    ref         = "artifact-pages-logical-routes"
    description = "Serve the SPA shell for logical application routes."
    expression  = "(${local.host_match} and (${local.reserved_path_exclusions}))"
    action      = "rewrite"
    enabled     = true
    action_parameters = {
      uri = {
        path = {
          value = "/index.html"
        }
      }
    }
  }

  projection_cache_paths = join(" or ", [
    "${local.normalized_path} eq \"/index.html\"",
    "${local.normalized_path} eq \"/preview-bridge.js\"",
    "${local.normalized_path} eq \"/license\"",
    "${local.normalized_path} eq \"/third_party_notices.txt\"",
    "${local.normalized_path} eq \"/assets\"",
    "starts_with(${local.normalized_path}, \"/assets/\")",
    "${local.normalized_path} eq \"/_indexes\"",
    "starts_with(${local.normalized_path}, \"/_indexes/\")",
    "${local.normalized_path} eq \"/_artifacts\"",
    "starts_with(${local.normalized_path}, \"/_artifacts/\")",
    "${local.normalized_path} eq \"/_previews\"",
    "starts_with(${local.normalized_path}, \"/_previews/\")",
  ])

  origin_cache_rule = {
    ref         = "artifact-pages-respect-origin-cache-control"
    description = "Make static projection objects cache eligible while honoring origin Cache-Control."
    expression  = "(${local.host_match} and (${local.projection_cache_paths}))"
    action      = "set_cache_settings"
    enabled     = true
    action_parameters = {
      cache = true
      edge_ttl = {
        mode = "respect_origin"
      }
      browser_ttl = {
        mode = "respect_origin"
      }
    }
  }

  # Edge features that rewrite or inject into response bodies. Delivered bytes must equal the
  # published objects, so each is forced to its non-modifying value for this hostname only.
  unchanged_delivery_rule = {
    ref         = "artifact-pages-unchanged-delivery"
    description = "Deliver published objects byte-for-byte: disable edge features that rewrite or inject into response bodies."
    expression  = "(${local.host_match})"
    action      = "set_config"
    enabled     = true
    action_parameters = {
      email_obfuscation        = false
      rocket_loader            = false
      automatic_https_rewrites = false
      fonts                    = false
      disable_rum              = true
      disable_zaraz            = true
      content_converter        = false
      polish                   = "off"
    }
  }

  config_composed_rules = concat(var.existing_config_rules, [local.unchanged_delivery_rule])
  config_composed_refs  = [for rule in local.config_composed_rules : try(rule.ref, "")]

  trusted_artifact_csp_expression = "concat(\"default-src https://\", http.host, \"/_artifacts/\", split(http.request.uri.path, \"/\", 4)[2], \"/ https: data: blob:; script-src https://\", http.host, \"/_artifacts/\", split(http.request.uri.path, \"/\", 4)[2], \"/ https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src https://\", http.host, \"/_artifacts/\", split(http.request.uri.path, \"/\", 4)[2], \"/ https: 'unsafe-inline' data: blob:\")"

  trusted_preview_csp_expression = "concat(\"default-src https://\", http.host, \"/_previews/\", split(http.request.uri.path, \"/\", 6)[2], \"/revisions/\", split(http.request.uri.path, \"/\", 6)[4], \"/files/ https: data: blob:; script-src https://\", http.host, \"/_previews/\", split(http.request.uri.path, \"/\", 6)[2], \"/revisions/\", split(http.request.uri.path, \"/\", 6)[4], \"/files/ https: 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; style-src https://\", http.host, \"/_previews/\", split(http.request.uri.path, \"/\", 6)[2], \"/revisions/\", split(http.request.uri.path, \"/\", 6)[4], \"/files/ https: 'unsafe-inline' data: blob:\")"

  trusted_html_resource_policy_rules = [
    {
      ref         = "artifact-pages-trusted-artifact-html-policy"
      description = "Allow trusted production HTML to load resources from its site namespace and HTTPS origins."
      expression  = "(${local.host_match} and starts_with(${local.normalized_path}, \"/_artifacts/\"))"
      action      = "rewrite"
      enabled     = true
      action_parameters = {
        headers = {
          "Content-Security-Policy" = {
            operation  = "set"
            expression = local.trusted_artifact_csp_expression
          }
          "X-Content-Type-Options" = {
            operation = "set"
            value     = "nosniff"
          }
        }
      }
    },
    {
      ref         = "artifact-pages-trusted-preview-html-policy"
      description = "Allow trusted raw preview HTML to load resources from its revision namespace and HTTPS origins."
      expression  = "(${local.host_match} and starts_with(${local.normalized_path}, \"/_previews/\") and ${local.normalized_path} contains \"/files/\")"
      action      = "rewrite"
      enabled     = true
      action_parameters = {
        headers = {
          "Content-Security-Policy" = {
            operation  = "set"
            expression = local.trusted_preview_csp_expression
          }
          "X-Content-Type-Options" = {
            operation = "set"
            value     = "nosniff"
          }
        }
      }
    },
  ]
}

resource "cloudflare_r2_custom_domain" "public" {
  count       = var.connect_custom_domain ? 1 : 0
  account_id  = var.account_id
  bucket_name = var.bucket_name
  domain      = lower(var.public_hostname)
  enabled     = true
  zone_id     = var.zone_id
  min_tls     = var.minimum_tls_version
}

resource "cloudflare_ruleset" "waf_custom_rules" {
  count = var.waf_custom_rules == null ? 0 : 1

  zone_id     = var.zone_id
  name        = local.waf_ruleset_name
  description = "Operator-configured WAF custom rules for the Artifact Pages hostname."
  kind        = "zone"
  phase       = "http_request_firewall_custom"
  rules       = local.waf_composed_rules

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(local.waf_composed_rules) > 0
      error_message = "waf_custom_rules must preserve or define at least one rule."
    }

    precondition {
      condition     = length(distinct(local.waf_composed_refs)) == length(local.waf_composed_refs)
      error_message = "WAF rule refs must be unique across existing rules, the generated preset rule, and caller rules."
    }

    precondition {
      condition     = alltrue([for ref in local.waf_composed_refs : !(local.waf_presets_active == false && ref == "artifact-pages-waf-presets")])
      error_message = "The ref artifact-pages-waf-presets is reserved for the generated combined preset rule."
    }

    precondition {
      condition     = alltrue([for expression_length in local.waf_final_expression_lengths : expression_length <= 4096])
      error_message = "Each hostname-wrapped WAF rule expression must be no longer than 4,096 characters."
    }

    precondition {
      condition     = trimspace(local.waf_ruleset_name) != ""
      error_message = "waf_custom_rules.ruleset_name must not be empty."
    }
  }
}

resource "cloudflare_ruleset" "logical_routes" {
  zone_id     = var.zone_id
  name        = var.transform_ruleset_name
  description = "Serve the app shell for logical routes while preserving the object-storage URL plane."
  kind        = "zone"
  phase       = "http_request_transform"

  rules = concat(var.existing_transform_rules, [local.logical_route_rule])
}

resource "cloudflare_ruleset" "origin_cache_policy" {
  zone_id     = var.zone_id
  name        = var.cache_ruleset_name
  description = "Respect Cache-Control written by the publisher for the public projection."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = concat(var.existing_cache_rules, [local.origin_cache_rule])
}

resource "cloudflare_ruleset" "trusted_html_resource_policy" {
  zone_id     = var.zone_id
  name        = var.response_header_ruleset_name
  description = "Apply the production HTML resource policy to production and raw preview objects."
  kind        = "zone"
  phase       = "http_response_headers_transform"

  rules = concat(var.existing_response_header_rules, local.trusted_html_resource_policy_rules)
}

resource "cloudflare_ruleset" "unchanged_delivery" {
  zone_id     = var.zone_id
  name        = var.config_ruleset_name
  description = "Disable edge features that rewrite or inject into HTML and other response bodies for the Artifact Pages hostname."
  kind        = "zone"
  phase       = "http_config_settings"

  rules = local.config_composed_rules

  lifecycle {
    precondition {
      condition     = length(distinct([for ref in local.config_composed_refs : ref if ref != ""])) == length([for ref in local.config_composed_refs : ref if ref != ""])
      error_message = "Configuration rule refs must be unique across existing_config_rules and the generated artifact-pages-unchanged-delivery rule."
    }
  }
}
