variable "name_prefix" {
  description = "Prefix for named AWS resources."
  type        = string
}

variable "aws_region" {
  description = "AWS deployment region."
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
  description = "Existing GitHub Actions OIDC provider ARN in the AWS provider target account."
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
