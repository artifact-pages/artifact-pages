# Guard: verification credentials are optional in mise (a missing env file is
# skipped), and the shell may still hold production Cloudflare variables. Stop
# before planning any change unless the zone really is the verification zone.
data "cloudflare_zone" "target" {
  zone_id = var.cloudflare_zone_id

  lifecycle {
    postcondition {
      condition     = self.name == var.expected_zone_name
      error_message = "cloudflare_zone_id does not belong to the verification zone; check ~/.config/artifact-pages/verify.env."
    }
  }
}

module "artifact_pages" {
  source = "../../modules/cloudflare"

  account_id             = var.cloudflare_account_id
  zone_id                = data.cloudflare_zone.target.zone_id
  bucket_name            = var.r2_bucket_name
  public_hostname        = var.public_hostname
  preview_retention_days = var.preview_retention_days
  connect_custom_domain  = var.connect_custom_domain
  registry_reader        = var.registry_reader
  waf_custom_rules       = var.waf_custom_rules
}
