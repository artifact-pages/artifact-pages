variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket and DNS zone."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Existing Cloudflare zone ID containing public_hostname."
  type        = string
}

variable "r2_bucket_name" {
  description = "Optional bucket name override. Omit to use the module's account-scoped default."
  type        = string
  default     = null
}

variable "public_hostname" {
  description = "Public hostname in the selected zone, without a scheme, port, or path."
  type        = string
}

variable "preview_retention_days" {
  description = "Provider-managed preview lifetime in whole days."
  type        = number
}
