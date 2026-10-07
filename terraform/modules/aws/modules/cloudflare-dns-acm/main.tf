locals {
  hostname                        = lower(var.cloudflare_domain.hostname)
  github_oidc_provider_account_id = split(":", var.github_oidc_provider_arn)[4]
}

data "aws_caller_identity" "primary" {
  provider = aws
}

data "aws_caller_identity" "us_east_1" {
  provider = aws.us_east_1
}

resource "terraform_data" "target_account_guard" {
  input = {
    primary   = data.aws_caller_identity.primary.account_id
    us_east_1 = data.aws_caller_identity.us_east_1.account_id
  }

  lifecycle {
    precondition {
      condition = (
        data.aws_caller_identity.primary.account_id == local.github_oidc_provider_account_id &&
        data.aws_caller_identity.us_east_1.account_id == local.github_oidc_provider_account_id
      )
      error_message = "Both AWS provider accounts must match the OIDC account."
    }
  }
}

resource "aws_acm_certificate" "viewer" {
  depends_on = [terraform_data.target_account_guard]

  provider          = aws.us_east_1
  domain_name       = local.hostname
  validation_method = "DNS"
  tags              = var.tags

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "acm_validation" {
  depends_on = [terraform_data.target_account_guard]

  for_each = {
    for option in aws_acm_certificate.viewer.domain_validation_options :
    option.domain_name => option
  }

  zone_id = var.cloudflare_domain.zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 1
  proxied = false
}

resource "aws_acm_certificate_validation" "viewer" {
  depends_on = [terraform_data.target_account_guard]

  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.viewer.arn
  validation_record_fqdns = [for record in cloudflare_dns_record.acm_validation : record.name]
}

module "artifact_pages" {
  source = "../.."

  depends_on = [terraform_data.target_account_guard]

  providers = {
    aws = aws
  }

  name_prefix               = var.name_prefix
  aws_region                = var.aws_region
  bucket_name               = var.bucket_name
  preview_retention_days    = var.preview_retention_days
  github_oidc_provider_arn  = var.github_oidc_provider_arn
  github_oidc_issuer_url    = var.github_oidc_issuer_url
  admin_github_subjects     = var.admin_github_subjects
  satellite_github_subjects = var.satellite_github_subjects
  aliases                   = [local.hostname]
  acm_certificate_arn       = aws_acm_certificate_validation.viewer.certificate_arn
  web_acl_arn               = var.web_acl_arn
  waf_custom_rules          = var.waf_custom_rules
  viewer_protocol_policy    = var.viewer_protocol_policy
  price_class               = var.price_class
  tags                      = var.tags
}

resource "cloudflare_dns_record" "distribution" {
  depends_on = [terraform_data.target_account_guard]

  zone_id = var.cloudflare_domain.zone_id
  name    = local.hostname
  type    = "CNAME"
  content = module.artifact_pages.distribution_domain_name
  ttl     = 1
  proxied = false
}
