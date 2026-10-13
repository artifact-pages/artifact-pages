resource "aws_acm_certificate" "viewer" {
  provider          = aws.us_east_1
  domain_name       = var.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for option in aws_acm_certificate.viewer.domain_validation_options : option.domain_name => option
  }

  zone_id         = var.route53_zone_id
  name            = each.value.resource_record_name
  type            = each.value.resource_record_type
  records         = [each.value.resource_record_value]
  ttl             = 60
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "viewer" {
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.viewer.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}

module "artifact_pages" {
  source = "../.."

  name_prefix               = var.name_prefix
  aws_region                = var.aws_region
  bucket_name               = var.bucket_name
  preview_retention_days    = var.preview_retention_days
  github_oidc_provider_arn  = var.github_oidc_provider_arn
  admin_github_subjects     = var.admin_github_subjects
  satellite_github_subjects = var.satellite_github_subjects
  aliases                   = [var.hostname]
  acm_certificate_arn       = aws_acm_certificate_validation.viewer.certificate_arn
  web_acl_arn               = var.web_acl_arn
  price_class               = var.price_class
  tags                      = var.tags
}

resource "aws_route53_record" "alias" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.route53_zone_id
  name    = var.hostname
  type    = each.key

  alias {
    name                   = module.artifact_pages.distribution_domain_name
    zone_id                = module.artifact_pages.distribution_hosted_zone_id
    evaluate_target_health = false
  }
}
