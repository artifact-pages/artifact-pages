provider "aws" {
  region = "us-west-2"
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

provider "cloudflare" {}

module "artifact_pages" {
  source = "../../modules/cloudflare-dns-acm"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    cloudflare    = cloudflare
  }

  aws_region               = "us-west-2"
  bucket_name              = null
  preview_retention_days   = 1
  github_oidc_provider_arn = "arn:aws:iam::000000000000:oidc-provider/token.actions.githubusercontent.com"
  admin_github_subjects    = ["repo:contract/admin:ref:refs/heads/main"]
  cloudflare_domain = {
    zone_id   = "11111111111111111111111111111111"
    zone_name = "example.com"
    hostname  = "aws.example.com"
  }
}
