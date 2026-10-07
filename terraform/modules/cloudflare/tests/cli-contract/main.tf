terraform {
  required_version = ">= 1.7.0, < 2.0.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.24.0, < 6.0.0"
    }
    external = {
      source  = "hashicorp/external"
      version = "~> 2.4"
    }
  }
}

variable "bucket_name" {
  type    = string
  default = null
}

variable "expected_bucket" {
  type = string
}

variable "access_key_id_env" {
  type    = string
  default = "CF_R2_ACCESS_KEY_ID"
}

variable "secret_access_key_env" {
  type    = string
  default = "CF_R2_SECRET_ACCESS_KEY"
}

variable "api_token_env" {
  type    = string
  default = "CF_API_TOKEN"
}

variable "registry_reader" {
  type = object({
    access_key_id_env     = string
    secret_access_key_env = string
    session_token_env     = optional(string)
  })
  default = null
}

variable "apprepo_dir" {
  type = string
}

variable "cli_contract_helper" {
  type = string
}

module "artifact_pages" {
  source = "../.."

  account_id             = "00000000000000000000000000000000"
  zone_id                = "11111111111111111111111111111111"
  bucket_name            = var.bucket_name
  public_hostname        = "contracts.example.com"
  preview_retention_days = 1
  access_key_id_env      = var.access_key_id_env
  secret_access_key_env  = var.secret_access_key_env
  api_token_env          = var.api_token_env
  registry_reader        = var.registry_reader
}

data "external" "cli_contract" {
  program     = ["go", "run", var.cli_contract_helper]
  working_dir = var.apprepo_dir

  query = {
    yaml                                           = module.artifact_pages.artifact_pages_deployment_config_yaml
    provider                                       = "cloudflare"
    expected_bucket                                = var.expected_bucket
    expected_account_id                            = "00000000000000000000000000000000"
    expected_zone_id                               = "11111111111111111111111111111111"
    expected_public_base_url                       = "https://contracts.example.com"
    expected_access_key_env                        = var.access_key_id_env
    expected_secret_key_env                        = var.secret_access_key_env
    expected_api_token_env                         = var.api_token_env
    expected_registry_reader_access_key_id_env     = var.registry_reader == null ? "" : var.registry_reader.access_key_id_env
    expected_registry_reader_secret_access_key_env = var.registry_reader == null ? "" : var.registry_reader.secret_access_key_env
    expected_registry_reader_session_token_env     = var.registry_reader == null ? "" : (var.registry_reader.session_token_env == null ? "" : var.registry_reader.session_token_env)
  }
}
