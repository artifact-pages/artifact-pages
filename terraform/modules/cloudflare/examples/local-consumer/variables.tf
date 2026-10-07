variable "cloudflare_account_id" {
  description = "Cloudflare account ID used by the local no-refresh plan fixture."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID used by the local no-refresh plan fixture."
  type        = string
}

variable "r2_bucket_name" {
  description = "Optional bucket name override. Omit to use the module's account-scoped default."
  type        = string
  default     = null
}

variable "public_hostname" {
  description = "Example public hostname for this local module contract plan."
  type        = string
}

variable "preview_retention_days" {
  description = "Provider-managed preview lifetime in whole days."
  type        = number
}
