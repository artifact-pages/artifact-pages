mock_provider "cloudflare" {}

run "default_bucket_output_parses_in_cli" {
  command = plan

  variables {
    bucket_name     = null
    expected_bucket = "artifact-pages"
  }

  assert {
    condition     = data.external.cli_contract.result["provider"] == "cloudflare"
    error_message = "the evaluated Cloudflare module output must parse as a Cloudflare CLI target"
  }

  assert {
    condition     = data.external.cli_contract.result["bucket"] == "artifact-pages"
    error_message = "the parsed CLI target must contain the default effective R2 bucket"
  }
}

run "bucket_override_output_parses_in_cli" {
  command = plan

  variables {
    bucket_name     = "artifact-pages-contract-override"
    expected_bucket = "artifact-pages-contract-override"
  }

  assert {
    condition     = data.external.cli_contract.result["provider"] == "cloudflare"
    error_message = "the evaluated Cloudflare module output must parse as a Cloudflare CLI target"
  }

  assert {
    condition     = data.external.cli_contract.result["bucket"] == "artifact-pages-contract-override"
    error_message = "the parsed CLI target must contain the explicit effective R2 bucket"
  }
}

run "nondefault_credential_env_overrides_parse_in_cli" {
  command = plan

  variables {
    bucket_name           = "artifact-pages-contract-override"
    expected_bucket       = "artifact-pages-contract-override"
    access_key_id_env     = "CUSTOM_R2_ACCESS_KEY_ID"
    secret_access_key_env = "CUSTOM_R2_SECRET_ACCESS_KEY"
    api_token_env         = "CUSTOM_CLOUDFLARE_API_TOKEN"
    registry_reader = {
      access_key_id_env     = "CF_R2_REGISTRY_READER_ACCESS_KEY_ID"
      secret_access_key_env = "CF_R2_REGISTRY_READER_SECRET_ACCESS_KEY"
      session_token_env     = "CF_R2_REGISTRY_READER_SESSION_TOKEN"
    }
  }

  assert {
    condition     = data.external.cli_contract.result["bucket"] == "artifact-pages-contract-override"
    error_message = "the parsed CLI target must keep the explicit effective R2 bucket"
  }
}
