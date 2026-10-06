module "artifact_pages_delivery" {
  source = "../../../terraform/modules/cloudflare/modules/delivery"

  account_id            = var.cloudflare_account_id
  zone_id               = var.cloudflare_zone_id
  bucket_name           = var.r2_bucket_name
  public_hostname       = var.public_hostname
  connect_custom_domain = var.connect_custom_domain
}

module "preview_retention" {
  source = "../../../terraform/modules/cloudflare/modules/retention"

  account_id             = var.cloudflare_account_id
  bucket_name            = var.r2_bucket_name
  preview_retention_days = var.preview_retention_days
}
