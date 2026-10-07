module "artifact_pages" {
  source = "../.."

  account_id             = var.cloudflare_account_id
  zone_id                = var.cloudflare_zone_id
  bucket_name            = var.r2_bucket_name
  public_hostname        = var.public_hostname
  preview_retention_days = var.preview_retention_days
}
