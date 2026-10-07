variable "account_id" {
  description = "Cloudflare account that owns the R2 bucket and zone configuration."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.account_id))
    error_message = "account_id must be a 32-character hexadecimal Cloudflare account ID."
  }
}

variable "zone_id" {
  description = "Existing Cloudflare DNS zone that owns public_hostname."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F]{32}$", var.zone_id))
    error_message = "zone_id must be a 32-character hexadecimal Cloudflare zone ID."
  }
}

variable "bucket_name" {
  description = "Name of the new private R2 bucket. Defaults to artifact-pages, which is account-scoped; availability is not guaranteed."
  type        = string
  default     = "artifact-pages"
  nullable    = false

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

variable "preview_retention_days" {
  description = "Whole-number provider-managed lifetime for objects under _previews/. This setting is not part of the CLI deployment configuration."
  type        = number

  validation {
    condition     = var.preview_retention_days >= 1 && var.preview_retention_days <= 36500 && floor(var.preview_retention_days) == var.preview_retention_days
    error_message = "preview_retention_days must be a whole number from 1 to 36500."
  }
}

variable "access_key_id_env" {
  description = "Environment-variable name for the primary R2 access key ID in generated CLI configuration."
  type        = string
  default     = "CF_R2_ACCESS_KEY_ID"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.access_key_id_env))
    error_message = "access_key_id_env must be a valid environment-variable name."
  }
}

variable "secret_access_key_env" {
  description = "Environment-variable name for the primary R2 secret access key in generated CLI configuration."
  type        = string
  default     = "CF_R2_SECRET_ACCESS_KEY"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.secret_access_key_env))
    error_message = "secret_access_key_env must be a valid environment-variable name."
  }
}

variable "api_token_env" {
  description = "Environment-variable name for the Cloudflare API token in generated CLI configuration."
  type        = string
  default     = "CF_API_TOKEN"

  validation {
    condition     = can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.api_token_env))
    error_message = "api_token_env must be a valid environment-variable name."
  }
}

variable "registry_reader" {
  description = "Optional environment-variable names for a delegated publisher's read-only registry credential. Omit this object for the normal setup."
  type = object({
    access_key_id_env     = string
    secret_access_key_env = string
    session_token_env     = optional(string)
  })
  default = null

  validation {
    condition = var.registry_reader == null ? true : (
      can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.registry_reader.access_key_id_env)) &&
      can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.registry_reader.secret_access_key_env)) &&
      (var.registry_reader.session_token_env == null || can(regex("^[A-Za-z_][A-Za-z0-9_]*$", var.registry_reader.session_token_env)))
    )
    error_message = "registry_reader must contain valid environment-variable names for its access key, secret, and optional session token."
  }
}

variable "additional_lifecycle_rules" {
  description = "Additional Cloudflare R2 lifecycle rules to keep in the bucket's complete lifecycle configuration. Do not duplicate the module-owned preview rules."
  type        = list(any)
  default     = []
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

variable "existing_cache_rules" {
  description = "Complete existing http_request_cache_settings root ruleset rules, in execution order, to preserve when this module owns that phase."
  type        = list(any)
  default     = []
}

variable "existing_response_header_rules" {
  description = "Complete existing http_response_headers_transform root ruleset rules, in execution order, to preserve when this module owns that phase."
  type        = list(any)
  default     = []
}

variable "existing_config_rules" {
  description = "Complete existing http_config_settings root ruleset rules, in execution order, to preserve when this module owns that phase."
  type        = list(any)
  default     = []
}

variable "waf_custom_rules" {
  description = "Optional operator-owned Cloudflare WAF custom-rule root for the selected public hostname. Omit it to leave the phase unmanaged."
  type = object({
    enabled      = optional(bool, true)
    ruleset_name = optional(string, "Artifact Pages WAF custom rules")
    presets = optional(object({
      https_only   = optional(bool, false)
      ip_allowlist = optional(list(string))
    }), {})
    existing_rules = optional(any, [])
    rules          = optional(any, [])
  })
  default = null

  validation {
    condition = var.waf_custom_rules == null ? true : (
      can(slice(var.waf_custom_rules.existing_rules, 0, length(var.waf_custom_rules.existing_rules))) &&
      can(slice(var.waf_custom_rules.rules, 0, length(var.waf_custom_rules.rules)))
    )
    error_message = "waf_custom_rules.existing_rules and waf_custom_rules.rules must be ordered list or tuple values."
  }

  validation {
    condition = var.waf_custom_rules == null ? true : try(
      trimspace(var.waf_custom_rules.ruleset_name) != "" &&
      alltrue([
        for rule in var.waf_custom_rules.existing_rules :
        startswith(jsonencode(rule.ref), "\"") && trimspace(rule.ref) != "" &&
        startswith(jsonencode(rule.expression), "\"") && trimspace(rule.expression) != "" &&
        startswith(jsonencode(rule.action), "\"") && trimspace(rule.action) != "" &&
        (try(rule.enabled, null) == null || try(rule.enabled == true, false) || try(rule.enabled == false, false))
      ]) &&
      alltrue([
        for rule in var.waf_custom_rules.rules :
        startswith(jsonencode(rule.ref), "\"") && trimspace(rule.ref) != "" &&
        startswith(jsonencode(rule.expression), "\"") && trimspace(rule.expression) != "" &&
        startswith(jsonencode(rule.action), "\"") && trimspace(rule.action) != "" &&
        (try(rule.enabled, null) == null || try(rule.enabled == true, false) || try(rule.enabled == false, false))
      ]),
      false,
    )
    error_message = "Each WAF rule must be an object with non-empty string ref, expression, and action fields; optional enabled must be boolean, and ruleset_name must not be empty."
  }

  validation {
    condition = var.waf_custom_rules == null ? true : var.waf_custom_rules.presets.ip_allowlist == null ? true : try(
      length(var.waf_custom_rules.presets.ip_allowlist) > 0 &&
      length(distinct(var.waf_custom_rules.presets.ip_allowlist)) == length(var.waf_custom_rules.presets.ip_allowlist) &&
      alltrue([
        for cidr in var.waf_custom_rules.presets.ip_allowlist :
        trimspace(cidr) == cidr && can(cidrhost(cidr, 0))
      ]),
      false,
    )
    error_message = "waf_custom_rules.presets.ip_allowlist must contain unique, valid IPv4 or IPv6 CIDRs; omit or set null to disable it."
  }
}

variable "transform_ruleset_name" {
  description = "Name for the http_request_transform phase root. For an imported ruleset, use its current name."
  type        = string
  default     = "Artifact Pages logical routes"
}

variable "cache_ruleset_name" {
  description = "Name for the http_request_cache_settings phase root. For an imported ruleset, use its current name."
  type        = string
  default     = "Artifact Pages origin cache policy"
}

variable "response_header_ruleset_name" {
  description = "Name for the http_response_headers_transform phase root. For an imported ruleset, use its current name."
  type        = string
  default     = "Artifact Pages trusted HTML resource policy"
}

variable "config_ruleset_name" {
  description = "Name for the http_config_settings phase root. For an imported ruleset, use its current name."
  type        = string
  default     = "Artifact Pages unchanged delivery"
}
