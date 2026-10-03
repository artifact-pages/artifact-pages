variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the R2 bucket and zone."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Existing Cloudflare zone ID containing the public hostname."
  type        = string
}

variable "r2_bucket_name" {
  description = "Optional R2 bucket name override. Omit to use the module's account-scoped artifact-pages default."
  type        = string
  default     = null
}

variable "public_hostname" {
  description = "Public hostname for the R2 custom domain, without a scheme or path."
  type        = string
}

variable "preview_retention_days" {
  description = "Whole-day preview object retention enforced by the R2 lifecycle policy."
  type        = number
}

variable "connect_custom_domain" {
  description = "Create the R2 custom-domain connection; false only when an existing connection is managed elsewhere."
  type        = bool
  default     = true
}

variable "registry_reader" {
  description = "Optional delegated publisher registry-reader environment names. Omit for the normal two-secret setup."
  type = object({
    access_key_id_env     = string
    secret_access_key_env = string
    session_token_env     = optional(string)
  })
  default = null
}

variable "waf_custom_rules" {
  description = "Optional operator-owned WAF configuration. The authoritative module validates provider-native rules and opt-in HTTPS/IP presets."
  type        = any
  default     = null
}

variable "expected_zone_name" {
  description = "Zone this verification root may manage; the plan fails for any other zone."
  type        = string
  default     = "artifact-pages.stream"
}
