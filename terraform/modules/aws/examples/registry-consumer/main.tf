module "artifact_pages" {
  source  = "tasuku43/artifact-pages/aws"
  version = "0.1.0"

  name_prefix               = var.name_prefix
  aws_region                = var.aws_region
  bucket_name               = var.bucket_name
  preview_retention_days    = var.preview_retention_days
  github_oidc_provider_arn  = var.github_oidc_provider_arn
  admin_github_subjects     = var.admin_github_subjects
  satellite_github_subjects = var.satellite_github_subjects
  aliases                   = var.aliases
  acm_certificate_arn       = var.acm_certificate_arn
  web_acl_arn               = var.web_acl_arn
  price_class               = var.price_class
  tags                      = var.tags
}
