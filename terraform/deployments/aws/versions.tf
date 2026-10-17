terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  backend "s3" {
    bucket              = "artifact-pages-verify-tfstate-231136241959"
    key                 = "aws-verify/terraform.tfstate"
    region              = "us-east-1"
    profile             = "artifact-pages-verify"
    allowed_account_ids = ["231136241959"]
    encrypt             = true
    use_lockfile        = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = ["231136241959"]
}
