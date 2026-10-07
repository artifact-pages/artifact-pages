module "artifact_pages" {
  source = "../../modules/cloudflare-dns-acm"

  waf_custom_rules       = var.waf_custom_rules
  viewer_protocol_policy = var.viewer_protocol_policy

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    cloudflare    = cloudflare
  }

  aws_region               = var.aws_region
  bucket_name              = var.bucket_name
  preview_retention_days   = var.preview_retention_days
  github_oidc_provider_arn = var.github_oidc_provider_arn
  admin_github_subjects    = var.admin_github_subjects
  cloudflare_domain = {
    zone_id   = var.cloudflare_zone_id
    zone_name = var.cloudflare_zone_name
    hostname  = var.aws_hostname
  }
}
