module "artifact_pages" {
  source = "../../modules/aws/modules/cloudflare-dns-acm"

  name_prefix               = var.name_prefix
  aws_region                = var.aws_region
  bucket_name               = var.bucket_name
  preview_retention_days    = var.preview_retention_days
  github_oidc_provider_arn  = var.github_oidc_provider_arn
  admin_github_subjects     = var.admin_github_subjects
  satellite_github_subjects = var.satellite_github_subjects
  web_acl_arn               = var.web_acl_arn
  waf_custom_rules          = var.waf_custom_rules
  viewer_protocol_policy    = var.viewer_protocol_policy
  price_class               = var.price_class
  tags                      = var.tags

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
    cloudflare    = cloudflare
  }

  cloudflare_domain = {
    zone_id   = var.cloudflare_zone_id
    zone_name = "artifact-pages.stream"
    hostname  = "aws.artifact-pages.stream"
  }
}
