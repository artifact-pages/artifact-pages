variable "aws_region" {
  description = "Region for the private S3 bucket and IAM roles."
  type        = string
  default     = "us-west-2"
}

variable "bucket_name" {
  description = "Optional S3 bucket name override; omit to use the module's deterministic AWS provider account-and-region default."
  type        = string
  default     = null
}

variable "preview_retention_days" {
  description = "Whole-day preview retention enforced by S3 lifecycle; this stays in Terraform and is not included in the CLI deployment config."
  type        = number
  default     = 1
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider ARN in the AWS provider target account."
  type        = string
  default     = "arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com"
}

variable "admin_github_subjects" {
  description = "Exact GitHub OIDC subjects allowed to assume the admin role."
  type        = list(string)
  default     = ["repo:example/admin:ref:refs/heads/main"]
}

variable "cloudflare_zone_id" {
  description = "Existing Cloudflare zone ID."
  type        = string
  default     = "11111111111111111111111111111111"
}

variable "cloudflare_zone_name" {
  description = "Existing Cloudflare zone name."
  type        = string
  default     = "example.com"
}

variable "aws_hostname" {
  description = "AWS verification hostname below the Cloudflare zone."
  type        = string
  default     = "aws.example.com"
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
