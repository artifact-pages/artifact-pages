variable "account_id" {
  description = "Cloudflare account that owns the existing R2 bucket."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", lower(var.account_id)))
    error_message = "account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "zone_id" {
  description = "Cloudflare zone that owns public_hostname."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", lower(var.zone_id)))
    error_message = "zone_id must be a 32-character hexadecimal Cloudflare zone ID."
  }
}

variable "bucket_name" {
  description = "Existing private R2 bucket containing the application and content projection."
  type        = string

  validation {
    condition     = trimspace(var.bucket_name) != ""
    error_message = "bucket_name must not be empty."
  }
}

variable "public_hostname" {
  description = "Hostname for the R2 custom domain, without a scheme or path."
  type        = string

  validation {
    condition = length(var.public_hostname) <= 253 && length(split(".", var.public_hostname)) >= 2 && alltrue([
      for label in split(".", var.public_hostname) :
      length(label) <= 63 && can(regex("^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$", label))
    ])
    error_message = "public_hostname must be a DNS hostname with valid labels, without a scheme, port, or path."
  }
}

variable "minimum_tls_version" {
  description = "Minimum TLS version accepted by the R2 custom domain."
  type        = string
  default     = "1.2"

  validation {
    condition     = contains(["1.0", "1.1", "1.2", "1.3"], var.minimum_tls_version)
    error_message = "minimum_tls_version must be one of 1.0, 1.1, 1.2, or 1.3."
  }
}

variable "connect_custom_domain" {
  description = "Whether Terraform should create the R2 custom-domain connection. The Cloudflare provider cannot import an existing connection."
  type        = bool
  default     = true
}

variable "existing_transform_rules" {
  description = "Complete existing http_request_transform root ruleset rules, in execution order, to preserve when this module owns that phase."
  type        = list(any)
  default     = []
}

variable "existing_firewall_rules" {
  description = "Complete existing http_request_firewall_custom root ruleset rules, in execution order, to preserve when this module owns that phase."
  type        = list(any)
  default     = []
}

variable "existing_cache_rules" {
  description = "Complete existing http_request_cache_settings root ruleset rules, in execution order, to preserve when this module owns that phase."
  type        = list(any)
  default     = []
}
