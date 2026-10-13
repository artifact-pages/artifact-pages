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

variable "route53_zone_id" {
  description = "ID of the existing public Route 53 hosted zone."
  type        = string
}

variable "hostname" {
  description = "Custom hostname within the existing Route 53 hosted zone."
  type        = string
}
