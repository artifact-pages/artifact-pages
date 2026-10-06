variable "account_id" {
  description = "Cloudflare account that owns the existing R2 bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "bucket_name" {
  description = "Name of the existing R2 bucket whose lifecycle rules this module manages."
  type        = string

  validation {
    condition     = trimspace(var.bucket_name) != ""
    error_message = "bucket_name must not be empty."
  }
}

variable "preview_retention_days" {
  description = "Positive whole-number lifetime for objects under _previews/."
  type        = number

  validation {
    condition     = var.preview_retention_days >= 1 && var.preview_retention_days <= 36500 && floor(var.preview_retention_days) == var.preview_retention_days
    error_message = "preview_retention_days must be a whole number from 1 to 36500."
  }
}

variable "additional_lifecycle_rules" {
  description = "All existing non-module lifecycle rules to preserve in the bucket's complete lifecycle configuration. This provider resource cannot import or destroy the API lifecycle configuration."
  type        = list(any)
  default     = []

  validation {
    condition = alltrue([
      for rule in var.additional_lifecycle_rules : try(
        trimspace(rule.id) != "" && !contains([
          "expire-preview-objects",
          "abort-preview-multipart-uploads",
        ], rule.id),
        false,
      )
    ]) && length(distinct([for rule in var.additional_lifecycle_rules : try(rule.id, null)])) == length(var.additional_lifecycle_rules)
    error_message = "additional_lifecycle_rules must have unique non-empty IDs and must not reuse module-owned preview rule IDs."
  }
}
