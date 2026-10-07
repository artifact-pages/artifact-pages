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
  description = "Complete existing http_config_settings root ruleset rules, in execution order, to preserve when this module owns that phase. The generated unchanged-delivery rule is appended after them."
  type        = list(any)
  default     = []
}

variable "waf_custom_rules" {
  description = "Optional operator-owned Cloudflare WAF custom-rule root."
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
  description = "Name of the http_request_transform phase-root ruleset. When importing an existing root, set its current name to avoid replacement."
  type        = string
  default     = "Artifact Pages logical routes"
}

variable "cache_ruleset_name" {
  description = "Name of the http_request_cache_settings phase-root ruleset. When importing an existing root, set its current name to avoid replacement."
  type        = string
  default     = "Artifact Pages origin cache policy"
}

variable "response_header_ruleset_name" {
  description = "Name of the http_response_headers_transform phase-root ruleset. When importing an existing root, set its current name to avoid replacement."
  type        = string
  default     = "Artifact Pages trusted HTML resource policy"
}

variable "config_ruleset_name" {
  description = "Name of the http_config_settings phase-root ruleset. When importing an existing root, set its current name to avoid replacement."
  type        = string
  default     = "Artifact Pages unchanged delivery"
}
