module "artifact_pages_delivery" {
  source = "./modules/delivery"
  value  = "delivery-contract"
}

module "preview_retention" {
  source = "./modules/retention"
  value  = "retention-contract"
}
