mock_provider "cloudflare" {}

variables {
  account_id             = "00000000000000000000000000000000"
  zone_id                = "11111111111111111111111111111111"
  public_hostname        = "artifacts.example.test"
  preview_retention_days = 1
}

run "nullable_policy_defaults_to_unmanaged" {
  command = plan

  assert {
    condition     = output.public_base_url == "https://artifacts.example.test"
    error_message = "The nullable WAF input must preserve the existing default consumer path."
  }
}

run "heterogeneous_provider_rule_maps_pass_validation_and_provider_schema" {
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
    condition     = output.public_base_url == "https://artifacts.example.test"
    error_message = "Provider-native, heterogeneous custom rule maps must survive module input validation and the provider plan schema."
  }

  assert {
    condition     = !strcontains(output.artifact_pages_deployment_config_yaml, "waf_custom_rules") && !strcontains(output.artifact_pages_deployment_config_yaml, "ip_allowlist") && !strcontains(output.artifact_pages_deployment_config_yaml, "existing-rate-limit") && !strcontains(output.artifact_pages_deployment_config_yaml, "caller-block")
    error_message = "Operator WAF policy must not leak into or alter the Artifact Pages CLI deployment YAML."
  }
}

run "non_string_required_fields_fail_custom_validation" {
  command = plan

  variables {
    waf_custom_rules = {
      rules = [{ ref = 43, expression = true, action = false }]
    }
  }

  expect_failures = [var.waf_custom_rules]
}

run "nested_non_object_rule_fails_custom_validation" {
  command = plan

  variables {
    waf_custom_rules = {
      rules = [["not-an-object"]]
    }
  }

  expect_failures = [var.waf_custom_rules]
}

run "empty_ip_allowlist_fails_custom_validation" {
  command = plan

  variables {
    waf_custom_rules = {
      presets = { ip_allowlist = [] }
    }
  }

  expect_failures = [var.waf_custom_rules]
}

run "invalid_cidr_fails_custom_validation" {
  command = plan

  variables {
    waf_custom_rules = {
      presets = { ip_allowlist = ["192.0.2.0/33"] }
    }
  }

  expect_failures = [var.waf_custom_rules]
}

run "config_phase_inputs_pass_through_the_entry_module" {
  command = plan

  variables {
    config_ruleset_name = "Imported config root"
    existing_config_rules = [
      { ref = "operator-bic", expression = "true", action = "set_config", action_parameters = { bic = true } },
    ]
  }

  assert {
    condition     = output.public_base_url == "https://artifacts.example.test"
    error_message = "The entry module must accept existing_config_rules and config_ruleset_name."
  }
}

run "invalid_account_id_fails_required_input_validation" {
  command = plan

  variables {
    account_id = "not-an-account-id"
  }

  expect_failures = [var.account_id]
}

run "invalid_zone_id_fails_required_input_validation" {
  command = plan

  variables {
    zone_id = "not-a-zone-id"
  }

  expect_failures = [var.zone_id]
}

run "invalid_public_hostname_fails_required_input_validation" {
  command = plan

  variables {
    public_hostname = "https://artifacts.example.test"
  }

  expect_failures = [var.public_hostname]
}

run "fractional_preview_retention_fails_required_input_validation" {
  command = plan

  variables {
    preview_retention_days = 1.5
  }

  expect_failures = [var.preview_retention_days]
}

run "empty_optional_bucket_override_fails_validation" {
  command = plan

  variables {
    bucket_name = ""
  }

  expect_failures = [var.bucket_name]
}
