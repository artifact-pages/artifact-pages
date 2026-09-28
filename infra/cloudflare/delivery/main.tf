locals {
  normalized_path = "lower(url_decode(http.request.uri.path, \"r\"))"
  host_match      = "lower(http.host) eq \"${lower(var.public_hostname)}\""

  reserved_path_exclusions = join(" and ", [
    "${local.normalized_path} ne \"/index.html\"",
    "${local.normalized_path} ne \"/preview-bridge.js\"",
    "${local.normalized_path} ne \"/assets\"",
    "not starts_with(${local.normalized_path}, \"/assets/\")",
    "${local.normalized_path} ne \"/_indexes\"",
    "not starts_with(${local.normalized_path}, \"/_indexes/\")",
    "${local.normalized_path} ne \"/_artifacts\"",
    "not starts_with(${local.normalized_path}, \"/_artifacts/\")",
    "${local.normalized_path} ne \"/_previews\"",
    "not starts_with(${local.normalized_path}, \"/_previews/\")",
    "${local.normalized_path} ne \"/_control\"",
    "not starts_with(${local.normalized_path}, \"/_control/\")",
  ])

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
    "${local.normalized_path} eq \"/assets\"",
    "starts_with(${local.normalized_path}, \"/assets/\")",
    "${local.normalized_path} eq \"/_indexes\"",
    "starts_with(${local.normalized_path}, \"/_indexes/\")",
    "${local.normalized_path} eq \"/_artifacts\"",
    "starts_with(${local.normalized_path}, \"/_artifacts/\")",
    "${local.normalized_path} eq \"/_previews\"",
    "starts_with(${local.normalized_path}, \"/_previews/\")",
  ])

  control_block_rule = {
    ref         = "artifact-pages-block-control-objects"
    description = "Keep private publisher coordination objects off the public hostname."
    expression  = "(${local.host_match} and (${local.normalized_path} eq \"/_control\" or starts_with(${local.normalized_path}, \"/_control/\")))"
    action      = "block"
    enabled     = true
  }

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

resource "cloudflare_r2_managed_domain" "development" {
  account_id  = var.account_id
  bucket_name = var.bucket_name
  enabled     = false
}

resource "cloudflare_ruleset" "logical_routes" {
  zone_id     = var.zone_id
  name        = "Artifact Pages logical routes"
  description = "Serve the app shell for logical routes while preserving the object-storage URL plane."
  kind        = "zone"
  phase       = "http_request_transform"

  rules = concat(var.existing_transform_rules, [local.logical_route_rule])
}

resource "cloudflare_ruleset" "control_boundary" {
  zone_id     = var.zone_id
  name        = "Artifact Pages private control boundary"
  description = "Block publisher coordination objects before delivery."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = concat([local.control_block_rule], var.existing_firewall_rules)
}

resource "cloudflare_ruleset" "origin_cache_policy" {
  zone_id     = var.zone_id
  name        = "Artifact Pages origin cache policy"
  description = "Respect Cache-Control written by the publisher for the public projection."
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules = concat(var.existing_cache_rules, [local.origin_cache_rule])
}
