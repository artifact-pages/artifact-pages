resource "cloudflare_r2_bucket" "origin" {
  account_id = var.account_id
  name       = var.bucket_name
}

module "delivery" {
  source = "./modules/delivery"

  account_id                     = var.account_id
  zone_id                        = var.zone_id
  bucket_name                    = cloudflare_r2_bucket.origin.name
  public_hostname                = var.public_hostname
  minimum_tls_version            = var.minimum_tls_version
  connect_custom_domain          = var.connect_custom_domain
  existing_transform_rules       = var.existing_transform_rules
  existing_cache_rules           = var.existing_cache_rules
  existing_response_header_rules = var.existing_response_header_rules
  existing_config_rules          = var.existing_config_rules
  waf_custom_rules               = var.waf_custom_rules
  transform_ruleset_name         = var.transform_ruleset_name
  cache_ruleset_name             = var.cache_ruleset_name
  response_header_ruleset_name   = var.response_header_ruleset_name
  config_ruleset_name            = var.config_ruleset_name
}

module "retention" {
  source = "./modules/retention"

  account_id                 = var.account_id
  bucket_name                = cloudflare_r2_bucket.origin.name
  preview_retention_days     = var.preview_retention_days
  additional_lifecycle_rules = var.additional_lifecycle_rules
}
