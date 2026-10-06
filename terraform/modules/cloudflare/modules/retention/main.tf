locals {
  artifact_pages_preview_rules = [
    {
      id      = "expire-preview-objects"
      enabled = true
      conditions = {
        prefix = "_previews/"
      }
      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = var.preview_retention_days * 24 * 60 * 60
        }
      }
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 7 * 24 * 60 * 60
        }
      }
    }
  ]

  # The R2 API returns lifecycle rules in ID order. The provider models them as
  # a list, so normalize configuration order to avoid a diff after every refresh.
  lifecycle_rules_by_id = {
    for rule in concat(local.artifact_pages_preview_rules, var.additional_lifecycle_rules) : rule.id => rule
  }
  lifecycle_rules = [
    for id in sort(keys(local.lifecycle_rules_by_id)) : local.lifecycle_rules_by_id[id]
  ]
}

resource "cloudflare_r2_bucket_lifecycle" "retention" {
  account_id  = var.account_id
  bucket_name = var.bucket_name
  rules       = local.lifecycle_rules
}
