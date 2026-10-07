variable "name_prefix" {
  description = "Prefix for named AWS resources."
  type        = string
  default     = "artifact-pages"
}

variable "aws_region" {
  description = "AWS region for the private S3 bucket and IAM roles."
  type        = string
}

variable "bucket_name" {
  description = "Optional S3 bucket name override. Omit to derive artifact-pages-<OIDC account ID>-<AWS region>."
  type        = string
  default     = null
}

variable "preview_retention_days" {
  description = "Whole-day preview retention enforced by S3 lifecycle; it is not part of the CLI deployment configuration."
  type        = number
}

variable "github_oidc_provider_arn" {
  description = "ARN of the existing GitHub Actions OIDC provider in the AWS account."
  type        = string
}

variable "admin_github_subjects" {
  description = "Exact GitHub OIDC subject claims allowed to assume the admin role."
  type        = list(string)
}

variable "satellite_github_subjects" {
  description = "Site IDs mapped to exact GitHub OIDC subject claims for publisher roles."
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
  description = "Optional caller-owned global WAFv2 web ACL ARN (us-east-1); exclusive with waf_custom_rules."
  type        = string
  default     = null
}

variable "waf_custom_rules" {
  description = "Optional module-owned WAF policy (ip_allowlist preset and AWS-native rules); see terraform/modules/aws/docs/waf.md."
  type        = any
  default     = null
}

variable "viewer_protocol_policy" {
  description = "redirect-to-https (default) or https-only on every CloudFront behavior."
  type        = string
  default     = "redirect-to-https"
}

variable "price_class" {
  description = "CloudFront edge location class."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Tags to apply to supported AWS resources."
  type        = map(string)
  default     = {}
}
