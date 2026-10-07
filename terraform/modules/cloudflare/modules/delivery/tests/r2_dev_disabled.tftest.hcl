mock_provider "cloudflare" {}

variables {
  account_id            = "00000000000000000000000000000000"
  zone_id               = "11111111111111111111111111111111"
  bucket_name           = "artifact-pages-test"
  public_hostname       = "artifacts.example.test"
  connect_custom_domain = false
}

run "r2_dev_domain_is_managed_and_disabled" {
  command = plan

  assert {
    condition     = cloudflare_r2_managed_domain.development.enabled == false && cloudflare_r2_managed_domain.development.bucket_name == "artifact-pages-test"
    error_message = "The bucket's r2.dev public development URL must be managed and disabled."
  }
}
