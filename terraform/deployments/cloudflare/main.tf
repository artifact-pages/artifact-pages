module "artifact_pages" {
  source = "../../../../terraform-cloudflare-artifact-pages"

  account_id             = var.cloudflare_account_id
  zone_id                = var.cloudflare_zone_id
  bucket_name            = var.r2_bucket_name
  public_hostname        = var.public_hostname
  preview_retention_days = var.preview_retention_days
  connect_custom_domain  = var.connect_custom_domain
  registry_reader        = var.registry_reader
}
