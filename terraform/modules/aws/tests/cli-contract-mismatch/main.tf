terraform {
  required_version = ">= 1.7.0, < 2.0.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "oidc_account_id" {
  type = string
}

module "artifact_pages" {
  source = "../.."

  name_prefix              = "artifact-pages-contract"
  aws_region               = "us-west-2"
  bucket_name              = "artifact-pages-contract-override"
  preview_retention_days   = 1
  github_oidc_provider_arn = "arn:aws:iam::${var.oidc_account_id}:oidc-provider/token.actions.githubusercontent.com"
  admin_github_subjects    = ["repo:contract/admin:ref:refs/heads/main"]
}

output "aws_deployment_config_yaml" {
  value = module.artifact_pages.aws_deployment_config_yaml
}
