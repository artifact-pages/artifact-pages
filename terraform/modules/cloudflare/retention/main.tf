resource "cloudflare_r2_bucket_lifecycle" "retention" {
  account_id  = var.account_id
  bucket_name = var.bucket_name

  rules = [
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
    },
    {
      id      = "abort-preview-multipart-uploads"
      enabled = true
      conditions = {
        prefix = "_previews/"
      }
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = 7 * 24 * 60 * 60
        }
      }
    }
  ]
}
