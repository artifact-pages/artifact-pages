variable "name_prefix" {
  description = "Prefix for named AWS resources."
  type        = string
}

variable "aws_region" {
  description = "AWS region for the S3 bucket and IAM roles."
  type        = string
}

variable "bucket_name" {
  description = "Optional S3 bucket name override; omit to use the module's deterministic AWS provider account-and-region default."
  type        = string
  default     = null
}

variable "preview_retention_days" {
  description = "Preview lifecycle duration in whole days."
  type        = number
}

variable "github_oidc_provider_arn" {
  description = "ARN for an existing GitHub Actions OIDC provider in the AWS provider target account."
  type        = string
}

variable "admin_github_subjects" {
  description = "Exact OIDC subject claims allowed to assume the admin role."
  type        = list(string)
}

variable "satellite_github_subjects" {
  description = "Site IDs mapped to exact OIDC subject claims allowed to assume each satellite role."
  type        = map(list(string))
  default     = {}
}

variable "aliases" {
  description = "Optional CloudFront alternate domain names."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN in us-east-1 for aliases."
  type        = string
  default     = null
}

variable "web_acl_arn" {
  description = "Optional customer-managed CloudFront WAFv2 web ACL ARN."
  type        = string
  default     = null
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Tags to apply to supported AWS resources."
  type        = map(string)
  default     = {}
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
