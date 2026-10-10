variable "name_prefix" {
  description = "Prefix for resources in the disposable AWS verification account."
  type        = string
  default     = "artifact-pages-aws-verify"
}

variable "aws_region" {
  description = "Region for the private S3 origin and IAM roles. ACM for CloudFront is always created in us-east-1."
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Optional private S3 bucket name override. Omit to derive it from the AWS account ID and region."
  type        = string
  default     = null
}

variable "preview_retention_days" {
  description = "Whole-day preview retention enforced by S3 lifecycle; it is not part of the CLI deployment configuration."
  type        = number
  default     = 1
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub OIDC provider ARN in the dedicated AWS verification account."
  type        = string
  default     = "arn:aws:iam::231136241959:oidc-provider/token.actions.githubusercontent.com"
}

variable "admin_github_subjects" {
  description = "Exact GitHub OIDC subjects for the dedicated aws-verify admin environment."
  type        = list(string)
  default     = ["repo:artifact-pages/admin:environment:aws-verify"]
}

variable "satellite_github_subjects" {
  description = "Exact GitHub OIDC subjects mapped to each disposable satellite site ID."
  type        = map(list(string))
  default = {
    aws-verify = ["repo:artifact-pages/docs:environment:aws-verify"]
  }
}

variable "cloudflare_zone_id" {
  description = "ID of the existing artifact-pages.stream zone; provide through an untracked variable file."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be the 32-character ID of the existing artifact-pages.stream zone."
  }
}

variable "web_acl_arn" {
  description = "Optional caller-managed global WAFv2 web ACL ARN in us-east-1."
  type        = string
  default     = null
}

variable "waf_custom_rules" {
  description = "Optional module-managed AWS WAF policy; omitted for the default verification deployment."
  type        = any
  default     = null
}

variable "viewer_protocol_policy" {
  description = "CloudFront viewer transport policy on every behavior."
  type        = string
  default     = "redirect-to-https"
}

variable "price_class" {
  description = "CloudFront edge location class."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Tags applied to supported AWS resources."
  type        = map(string)
  default     = {}
}
