mock_provider "cloudflare" {}

variables {
  account_id             = "00000000000000000000000000000000"
  bucket_name            = "retention-contract"
  preview_retention_days = 1
}

run "default_rules_match_api_order_and_keep_expiration" {
  command = plan
  module {
    source = "./modules/retention"
  }
  assert {
    condition     = [for rule in cloudflare_r2_bucket_lifecycle.retention.rules : rule.id] == ["expire-preview-objects"]
    error_message = "Default lifecycle rules must match the API read-back order."
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.retention.rules[0].abort_multipart_uploads_transition.condition.max_age == 604800 && cloudflare_r2_bucket_lifecycle.retention.rules[0].delete_objects_transition.condition.max_age == 86400
    error_message = "Sorting must not swap the transitions or change retention periods."
  }
}

run "additional_rules_are_sorted_without_losing_policy" {
  command = plan
  module {
    source = "./modules/retention"
  }
  variables {
    preview_retention_days = 3
    additional_lifecycle_rules = [
      {
        id                        = "z-existing"
        enabled                   = false
        conditions                = { prefix = "archived/" }
        delete_objects_transition = { condition = { type = "Age", max_age = 172800 } }
      },
      {
        id                        = "a-existing"
        enabled                   = true
        conditions                = { prefix = "reports/" }
        delete_objects_transition = { condition = { type = "Age", max_age = 345600 } }
      }
    ]
  }
  assert {
    condition     = [for rule in cloudflare_r2_bucket_lifecycle.retention.rules : rule.id] == ["a-existing", "expire-preview-objects", "z-existing"]
    error_message = "All rules must be ordered by ID regardless of input order."
  }
  assert {
    condition     = cloudflare_r2_bucket_lifecycle.retention.rules[0].conditions.prefix == "reports/" && cloudflare_r2_bucket_lifecycle.retention.rules[0].delete_objects_transition.condition.max_age == 345600 && cloudflare_r2_bucket_lifecycle.retention.rules[1].delete_objects_transition.condition.max_age == 259200 && !cloudflare_r2_bucket_lifecycle.retention.rules[2].enabled && cloudflare_r2_bucket_lifecycle.retention.rules[2].conditions.prefix == "archived/" && cloudflare_r2_bucket_lifecycle.retention.rules[2].delete_objects_transition.condition.max_age == 172800
    error_message = "Normalization must preserve caller policies and still plan retention changes."
  }
}
