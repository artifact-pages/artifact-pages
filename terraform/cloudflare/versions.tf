terraform {
  required_version = ">= 1.5.0, < 2.0.0"

  backend "local" {
    path = "../../.local/terraform/cloudflare/terraform.tfstate"
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.24.0, < 6.0.0"
    }
  }
}

provider "cloudflare" {}
