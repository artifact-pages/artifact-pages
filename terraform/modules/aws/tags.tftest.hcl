mock_provider "aws" {
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}

variables {
  aws_region                = "us-east-1"
  preview_retention_days    = 30
  github_oidc_provider_arn  = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  admin_github_subjects     = ["repo:example/admin:ref:refs/heads/main"]
  satellite_github_subjects = { docs = ["repo:example/docs:ref:refs/heads/main"] }
}

run "no_module_tags_by_default" {
  command = plan

  assert {
    condition = alltrue([
      length(aws_s3_bucket.origin.tags) == 0,
      length(aws_cloudfront_distribution.site.tags) == 0,
      length(aws_iam_role.admin.tags) == 0,
      length(aws_iam_role.satellite["docs"].tags) == 0,
    ])
    error_message = "The module must not add tags by default."
  }
}

run "caller_tags_are_applied" {
  command = plan
  variables {
    tags = { cost-center = "1234", service = "docs" }
    waf_custom_rules = {
      presets = { ip_allowlist = ["192.0.2.0/24"] }
    }
  }

  assert {
    condition = alltrue([
      aws_s3_bucket.origin.tags == var.tags,
      aws_cloudfront_distribution.site.tags == var.tags,
      aws_iam_role.admin.tags == var.tags,
      aws_iam_role.satellite["docs"].tags == var.tags,
      alltrue([for ip_set in aws_wafv2_ip_set.allowlist : ip_set.tags == var.tags]),
      aws_wafv2_web_acl.viewer[0].tags == var.tags,
    ])
    error_message = "Caller tags must reach the bucket, distribution, roles and module-created WAF resources."
  }
}
