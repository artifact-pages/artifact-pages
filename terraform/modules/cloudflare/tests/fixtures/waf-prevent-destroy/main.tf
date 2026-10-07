terraform {
  required_version = ">= 1.5.0, < 2.0.0"
}

variable "enabled" {
  type = bool
}

resource "terraform_data" "waf_guard" {
  count = var.enabled ? 1 : 0
  input = "local-only-waf-lifecycle-proof"

  lifecycle {
    prevent_destroy = true
  }
}
