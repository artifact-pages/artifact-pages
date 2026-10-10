terraform {
  required_version = ">= 1.7.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
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

variable "oidc_account_id" {
  type    = string
  default = "000000000000"
}

variable "apprepo_dir" {
  type = string
}

variable "cli_contract_helper" {
  type = string
}

module "artifact_pages" {
  source = "../.."

  name_prefix               = "artifact-pages-contract"
  aws_region                = "us-west-2"
  bucket_name               = var.bucket_name
  preview_retention_days    = 1
  github_oidc_provider_arn  = "arn:aws:iam::${var.oidc_account_id}:oidc-provider/token.actions.githubusercontent.com"
  admin_github_subjects     = ["repo:contract@123456789/admin@1234567890:ref:refs/heads/main"]
  satellite_github_subjects = {}
}

data "external" "cli_contract" {
  program     = ["go", "run", var.cli_contract_helper]
  working_dir = var.apprepo_dir

  query = {
    yaml                     = module.artifact_pages.aws_deployment_config_yaml
    provider                 = "aws"
    expected_bucket          = var.expected_bucket
    expected_account_id      = "000000000000"
    expected_region          = "us-west-2"
    expected_distribution_id = "E0000000000000"
  }
}
