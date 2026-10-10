terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  backend "s3" {
    bucket = "artifact-pages-tfstate"
    key    = "aws-verify"
    region = "auto"

    endpoints = {
      s3 = "https://9ac354c8aa31d424224d8c4f3aa8ba2a.r2.cloudflarestorage.com"
    }

    profile                  = "artifact-pages-tfstate"
    shared_credentials_files = ["~/.config/artifact-pages/tfstate-aws-credentials"]

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
    use_lockfile                = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.24"
    }
  }
}

provider "aws" {
  region              = var.aws_region
  allowed_account_ids = ["231136241959"]
}

provider "aws" {
  alias               = "us_east_1"
  region              = "us-east-1"
  allowed_account_ids = ["231136241959"]
}

provider "cloudflare" {}
