terraform {
  required_version = ">= 1.10.0, < 2.0.0"

  backend "s3" {
    bucket = "artifact-pages-tfstate"
    key    = "cloudflare-verify"
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
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.24.0, < 6.0.0"
    }
  }
}

provider "cloudflare" {}
