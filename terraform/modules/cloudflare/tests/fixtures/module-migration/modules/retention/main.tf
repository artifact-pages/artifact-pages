variable "value" {
  type = string
}

resource "terraform_data" "contract" {
  input = var.value
}
