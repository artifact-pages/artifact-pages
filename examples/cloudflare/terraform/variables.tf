variable "cloudflare_account_id" {
  description = "Cloudflare account ID."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone ID for the public hostname."
  type        = string
}

variable "r2_bucket_name" {
  description = "Existing private R2 bucket name."
  type        = string
}

variable "public_hostname" {
  description = "Public hostname, such as artifacts.example.com."
  type        = string
}

variable "connect_custom_domain" {
  description = "Create the R2 custom-domain connection; set false if it already exists because the provider cannot import it."
  type        = bool
  default     = true
}

variable "preview_retention_days" {
  description = "Provider-managed _previews/ object retention. This lifecycle setting is separate from the CLI deployment configuration."
  type        = number

  validation {
    condition     = var.preview_retention_days >= 1 && var.preview_retention_days <= 36500 && floor(var.preview_retention_days) == var.preview_retention_days
    error_message = "preview_retention_days must be a whole number from 1 to 36500."
  }
}
