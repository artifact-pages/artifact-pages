module "artifact_pages" {
  source  = "tasuku43/artifact-pages/cloudflare"
  version = "0.1.0"

  account_id             = var.cloudflare_account_id
  zone_id                = var.cloudflare_zone_id
  bucket_name            = var.r2_bucket_name
  public_hostname        = var.public_hostname
  preview_retention_days = var.preview_retention_days
}
