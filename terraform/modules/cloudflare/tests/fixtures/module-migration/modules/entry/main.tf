variable "value" {
  type = string
}

module "delivery" {
  source = "../delivery"
  value  = "delivery-contract"
}

module "retention" {
  source = "../retention"
  value  = "retention-contract"
}
