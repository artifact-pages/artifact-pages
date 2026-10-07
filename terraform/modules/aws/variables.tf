variable "name_prefix" {
  description = "Prefix used for named infrastructure resources."
  type        = string
  default     = "artifact-pages"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name_prefix))
    error_message = "name_prefix must be 2-31 lowercase letters, digits, or hyphens and start with a letter."
  }
}

variable "aws_region" {
  description = "Region for the private S3 bucket and IAM roles."
  type        = string
}

variable "bucket_name" {
  description = "Optional globally unique S3 bucket name override. Defaults to artifact-pages-<AWS provider account ID>-<AWS region>; availability is not guaranteed."
  type        = string
  default     = null

  validation {
    condition     = var.bucket_name == null ? true : trimspace(var.bucket_name) != ""
    error_message = "bucket_name must be omitted or contain a non-empty S3 bucket name."
  }
}

variable "preview_retention_days" {
  description = "Provider-managed lifetime for all objects under _previews/."
  type        = number

  validation {
    condition     = var.preview_retention_days >= 1 && var.preview_retention_days <= 36500 && floor(var.preview_retention_days) == var.preview_retention_days
    error_message = "preview_retention_days must be a whole number from 1 to 36500."
  }
}

variable "github_oidc_provider_arn" {
  description = "ARN of the existing GitHub Actions OIDC provider; its account ID must match the AWS provider target account."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:iam::[0-9]{12}:oidc-provider/.+$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must be an IAM OIDC provider ARN with a 12-digit account ID."
  }
}

variable "github_oidc_issuer_url" {
  description = "Issuer URL for the configured OIDC provider."
  type        = string
  default     = "https://token.actions.githubusercontent.com"
}

variable "admin_github_subjects" {
  description = "Exact GitHub OIDC sub claims allowed to assume the admin role."
  type        = list(string)

  validation {
    condition     = length(var.admin_github_subjects) > 0 && alltrue([for subject in var.admin_github_subjects : startswith(subject, "repo:")])
    error_message = "admin_github_subjects must contain one or more repo:... GitHub OIDC subjects."
  }
}

variable "satellite_github_subjects" {
  description = "Map of site IDs to exact GitHub OIDC sub claims allowed to publish that site."
  type        = map(list(string))
  default     = {}

  validation {
    condition = alltrue([
      for site_id, subjects in var.satellite_github_subjects :
      can(regex("^[a-z0-9]+(-[a-z0-9]+)*$", site_id)) && site_id != "assets" && length(subjects) > 0 && alltrue([for subject in subjects : startswith(subject, "repo:")])
    ])
    error_message = "Satellite map keys must be non-reserved site IDs and every value must contain repo:... OIDC subjects."
  }
}

variable "aliases" {
  description = "Optional CloudFront alternate domain names. DNS records are managed by the caller."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN in us-east-1 for aliases."
  type        = string
  default     = null
}

variable "web_acl_arn" {
  description = "Optional customer-managed WAFv2 web ACL ARN for viewer access policy."
  type        = string
  default     = null

  validation {
    condition     = var.web_acl_arn == null ? true : can(regex("^arn:[^:]+:wafv2:us-east-1:[0-9]{12}:global/webacl/[A-Za-z0-9_-]+/[A-Za-z0-9-]+$", var.web_acl_arn))
    error_message = "web_acl_arn must be a global WAFv2 web ACL ARN in us-east-1, or null."
  }
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200, or PriceClass_All."
  }
}

variable "tags" {
  description = "Tags applied to supported AWS resources."
  type        = map(string)
  default     = {}
}

check "aliases_require_certificate" {
  assert {
    condition     = length(var.aliases) == 0 || var.acm_certificate_arn != null
    error_message = "Set acm_certificate_arn in us-east-1 when aliases are configured."
  }
}

variable "viewer_protocol_policy" {
  description = "CloudFront viewer transport policy on every behavior: redirect HTTP (default), or reject HTTP with https-only. Independent of WAF."
  type        = string
  default     = "redirect-to-https"
  nullable    = false
  validation {
    condition     = contains(["redirect-to-https", "https-only"], var.viewer_protocol_policy)
    error_message = "viewer_protocol_policy must be redirect-to-https or https-only."
  }
}

variable "waf_custom_rules" {
  description = "Optional module-owned global WAF policy: ip_allowlist preset and validated AWS-native rule blocks. Mutually exclusive with web_acl_arn. See docs/waf.md for the supported subset and retirement procedure."
  type = object({
    default_action = optional(any, { allow = {} })
    presets        = optional(any, {})
    rules          = optional(any, [])
    custom_response_bodies = optional(map(object({
      content      = string
      content_type = string
    })), {})
    visibility_config = optional(object({
      cloudwatch_metrics_enabled = optional(bool, true)
      sampled_requests_enabled   = optional(bool, false)
      metric_name                = optional(string)
    }), {})
  })
  default = null
}
