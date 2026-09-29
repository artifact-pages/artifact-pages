module "artifact_pages" {
  source = "../../../terraform-aws-artifact-pages"

  name_prefix               = var.name_prefix
  aws_region                = var.aws_region
  bucket_name               = var.bucket_name
  preview_retention_days    = var.preview_retention_days
  github_oidc_provider_arn  = var.github_oidc_provider_arn
  admin_github_subjects     = var.admin_github_subjects
  satellite_github_subjects = var.satellite_github_subjects
  aliases                   = var.aliases
  acm_certificate_arn       = var.acm_certificate_arn
  price_class               = var.price_class
  tags                      = var.tags
}
