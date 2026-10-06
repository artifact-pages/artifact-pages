mock_provider "cloudflare" {}

variables {
  account_id            = "00000000000000000000000000000000"
  zone_id               = "11111111111111111111111111111111"
  bucket_name           = "artifact-pages-test"
  public_hostname       = "Artifacts.Example.Test"
  connect_custom_domain = false
}

run "null_policy_does_not_create_waf_root" {
  command = plan

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules) == 0
    error_message = "A null WAF policy must leave the custom firewall phase unmanaged."
  }
}

run "https_only_creates_one_host_scoped_block_rule" {
  command = plan

  variables {
    waf_custom_rules = {
      presets = { https_only = true }
    }
  }

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules[0].rules) == 1
    error_message = "HTTPS-only must compile to one generated rule."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[0].ref == "artifact-pages-waf-presets" && cloudflare_ruleset.waf_custom_rules[0].rules[0].action == "block" && cloudflare_ruleset.waf_custom_rules[0].rules[0].enabled
    error_message = "The combined preset rule must have its stable ref, block action, and enabled state."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[0].expression == "(lower(http.host) eq \"artifacts.example.test\") and ((not ssl or cf.edge.server_port ne 443))"
    error_message = "HTTPS-only must block insecure or non-443 requests only on the configured hostname."
  }
}

run "ip_allowlist_creates_one_cidr_block_rule" {
  command = plan

  variables {
    waf_custom_rules = {
      presets = { ip_allowlist = ["192.0.2.0/24", "2001:db8::/32"] }
    }
  }

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules[0].rules) == 1
    error_message = "IP allowlist must compile to one generated rule."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[0].expression == "(lower(http.host) eq \"artifacts.example.test\") and ((not ip.src in {192.0.2.0/24 2001:db8::/32}))"
    error_message = "The IP preset must use a CIDR set and remain scoped to the configured hostname."
  }
}

run "both_presets_compile_to_one_or_violation_block" {
  command = plan

  variables {
    waf_custom_rules = {
      presets = {
        https_only   = true
        ip_allowlist = ["192.0.2.1/32"]
      }
    }
  }

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules[0].rules) == 1
    error_message = "All active presets must consume exactly one custom-rule slot."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[0].expression == "(lower(http.host) eq \"artifacts.example.test\") and ((not ssl or cf.edge.server_port ne 443) or (not ip.src in {192.0.2.1/32}))"
    error_message = "The combined rule must block the OR of violations, allowing only HTTPS on port 443 from an allowed address."
  }
}

run "inactive_presets_do_not_add_generated_rule" {
  command = plan

  variables {
    waf_custom_rules = {
      rules = [
        {
          ref        = "caller-disabled"
          expression = "ip.src eq 192.0.2.1"
          action     = "block"
          enabled    = false
        },
        {
          ref        = "caller-block"
          expression = "ip.src eq 192.0.2.2 or ip.src.country eq \"ZZ\""
          action     = "block"
        },
      ]
    }
  }

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules[0].rules) == 2 && cloudflare_ruleset.waf_custom_rules[0].rules[0].ref == "caller-disabled" && !cloudflare_ruleset.waf_custom_rules[0].rules[0].enabled
    error_message = "Disabled presets must not add a generated rule, and per-rule disablement must be preserved."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[1].ref == "caller-block" && cloudflare_ruleset.waf_custom_rules[0].rules[1].enabled && cloudflare_ruleset.waf_custom_rules[0].rules[1].expression == "(lower(http.host) eq \"artifacts.example.test\") and (ip.src eq 192.0.2.2 or ip.src.country eq \"ZZ\")"
    error_message = "Top-level caller OR expressions must remain grouped inside the hostname guard."
  }
}

run "disabled_policy_disables_added_rules_but_preserves_existing_rules" {
  command = plan

  variables {
    waf_custom_rules = {
      enabled = false
      existing_rules = [{
        ref        = "existing-block"
        expression = "ip.src eq 192.0.2.2"
        action     = "block"
        enabled    = true
        logging    = { enabled = true }
      }]
      presets = { https_only = true }
      rules = [{
        ref        = "caller-block"
        expression = "ip.src eq 192.0.2.1"
        action     = "block"
      }]
    }
  }

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules[0].rules) == 3
    error_message = "The disabled root must retain existing, preset, and caller rules in order."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[0].ref == "existing-block" && cloudflare_ruleset.waf_custom_rules[0].rules[0].enabled && cloudflare_ruleset.waf_custom_rules[0].rules[0].logging.enabled
    error_message = "Existing rules and their provider-native attributes must remain unchanged when policy is disabled."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[1].ref == "artifact-pages-waf-presets" && !cloudflare_ruleset.waf_custom_rules[0].rules[1].enabled && cloudflare_ruleset.waf_custom_rules[0].rules[2].ref == "caller-block" && !cloudflare_ruleset.waf_custom_rules[0].rules[2].enabled
    error_message = "The disabled policy must disable the generated preset and every caller rule."
  }
}

run "heterogeneous_provider_native_rule_objects_keep_attributes_and_order" {
  command = plan

  variables {
    waf_custom_rules = {
      existing_rules = [
        {
          ref        = "existing-rate-limit"
          expression = "true"
          action     = "block"
          ratelimit = {
            characteristics = ["ip.src"]
            period          = 60
          }
        },
        {
          ref        = "existing-skip"
          expression = "false"
          action     = "skip"
          action_parameters = {
            phases  = ["http_request_firewall_managed"]
            ruleset = "current"
          }
        },
      ]
      rules = [
        {
          ref        = "caller-logged-block"
          expression = "ip.src eq 192.0.2.1"
          action     = "block"
          logging    = { enabled = true }
        },
        {
          ref        = "caller-block"
          expression = "ip.src eq 192.0.2.2"
          action     = "block"
        },
      ]
    }
  }

  assert {
    condition     = length(cloudflare_ruleset.waf_custom_rules[0].rules) == 4
    error_message = "Existing rules must precede caller rules, with no inactive preset rule."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[0].ratelimit.period == 60 && cloudflare_ruleset.waf_custom_rules[0].rules[1].action_parameters.ruleset == "current"
    error_message = "Distinct provider-native action parameter shapes on imported rules must survive composition."
  }

  assert {
    condition     = cloudflare_ruleset.waf_custom_rules[0].rules[2].logging.enabled && cloudflare_ruleset.waf_custom_rules[0].rules[2].expression == "(lower(http.host) eq \"artifacts.example.test\") and (ip.src eq 192.0.2.1)" && cloudflare_ruleset.waf_custom_rules[0].rules[3].expression == "(lower(http.host) eq \"artifacts.example.test\") and (ip.src eq 192.0.2.2)"
    error_message = "Caller rule attributes and order must survive while each expression is host-scoped."
  }
}

run "direct_delivery_rejects_wrong_rule_shape" {
  command = plan

  variables {
    waf_custom_rules = { rules = [["not-an-object"]] }
  }

  expect_failures = [var.waf_custom_rules]
}

run "direct_delivery_rejects_empty_ip_allowlist" {
  command = plan

  variables {
    waf_custom_rules = { presets = { ip_allowlist = [] } }
  }

  expect_failures = [var.waf_custom_rules]
}

run "direct_delivery_rejects_invalid_ip_cidr" {
  command = plan

  variables {
    waf_custom_rules = { presets = { ip_allowlist = ["192.0.2.0/33"] } }
  }

  expect_failures = [var.waf_custom_rules]
}

run "direct_delivery_rejects_duplicate_ip_cidrs" {
  command = plan

  variables {
    waf_custom_rules = { presets = { ip_allowlist = ["192.0.2.1/32", "192.0.2.1/32"] } }
  }

  expect_failures = [var.waf_custom_rules]
}

run "direct_delivery_rejects_non_string_rule_fields" {
  command = plan

  variables {
    waf_custom_rules = { rules = [{ ref = 2, expression = true, action = false }] }
  }

  expect_failures = [var.waf_custom_rules]
}

run "direct_delivery_rejects_empty_policy_root" {
  command = plan

  variables {
    waf_custom_rules = {}
  }

  expect_failures = [cloudflare_ruleset.waf_custom_rules[0]]
}

run "direct_delivery_rejects_duplicate_refs" {
  command = plan

  variables {
    waf_custom_rules = {
      rules = [
        { ref = "same", expression = "true", action = "block" },
        { ref = "same", expression = "false", action = "block" },
      ]
    }
  }

  expect_failures = [cloudflare_ruleset.waf_custom_rules[0]]
}

run "direct_delivery_reserves_combined_preset_ref" {
  command = plan

  variables {
    waf_custom_rules = {
      rules = [{ ref = "artifact-pages-waf-presets", expression = "true", action = "block" }]
    }
  }

  expect_failures = [cloudflare_ruleset.waf_custom_rules[0]]
}

run "direct_delivery_rejects_overlength_wrapped_expression" {
  command = plan

  variables {
    waf_custom_rules = {
      rules = [{ ref = "long-expression", expression = format("%04050d", 0), action = "block" }]
    }
  }

  expect_failures = [cloudflare_ruleset.waf_custom_rules[0]]
}

run "unchanged_delivery_rule_is_host_scoped_and_disables_body_rewriting" {
  command = plan

  assert {
    condition     = cloudflare_ruleset.unchanged_delivery.phase == "http_config_settings" && cloudflare_ruleset.unchanged_delivery.kind == "zone" && length(cloudflare_ruleset.unchanged_delivery.rules) == 1
    error_message = "The module must own an http_config_settings zone root with exactly the generated rule by default."
  }

  assert {
    condition     = cloudflare_ruleset.unchanged_delivery.rules[0].expression == "(lower(http.host) eq \"artifacts.example.test\")" && cloudflare_ruleset.unchanged_delivery.rules[0].action == "set_config" && cloudflare_ruleset.unchanged_delivery.rules[0].enabled
    error_message = "The rule must be scoped to the lowercase public hostname, not the zone."
  }

  assert {
    condition = (
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.email_obfuscation == false &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.rocket_loader == false &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.automatic_https_rewrites == false &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.fonts == false &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.disable_rum == true &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.disable_zaraz == true &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.content_converter == false &&
      cloudflare_ruleset.unchanged_delivery.rules[0].action_parameters.polish == "off"
    )
    error_message = "Every body-rewriting edge feature must be forced to its non-modifying value."
  }
}

run "existing_config_rules_are_preserved_before_the_generated_rule" {
  command = plan

  variables {
    existing_config_rules = [
      { ref = "operator-bic", expression = "true", action = "set_config", action_parameters = { bic = true } },
    ]
  }

  assert {
    condition     = length(cloudflare_ruleset.unchanged_delivery.rules) == 2 && cloudflare_ruleset.unchanged_delivery.rules[0].ref == "operator-bic" && cloudflare_ruleset.unchanged_delivery.rules[1].ref == "artifact-pages-unchanged-delivery"
    error_message = "Existing configuration rules must keep their order and the generated rule must follow them."
  }
}

run "config_rules_reject_duplicate_refs" {
  command = plan

  variables {
    existing_config_rules = [
      { ref = "artifact-pages-unchanged-delivery", expression = "true", action = "set_config", action_parameters = { bic = true } },
    ]
  }

  expect_failures = [cloudflare_ruleset.unchanged_delivery]
}
