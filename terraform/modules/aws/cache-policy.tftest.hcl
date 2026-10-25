# Mocked provider: apply makes resource IDs known so behaviours can be compared with policy IDs.
mock_provider "aws" {
  mock_resource "aws_cloudfront_cache_policy" {
    defaults = {
      id = "mock-cache-policy"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn = "arn:aws:cloudfront::123456789012:function/mock"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
    arn        = "arn:aws:iam::123456789012:root"
    user_id    = "AIDATESTSUBJECTS"
  }
}

# Distinct IDs so each behaviour can be tied to the policy it references.
override_resource {
  target = aws_cloudfront_cache_policy.origin_respecting
  values = {
    id = "policy-origin-respecting"
  }
}

override_resource {
  target = aws_cloudfront_cache_policy.no_store
  values = {
    id = "policy-no-store"
  }
}

run "origin_respecting_cache_policy_and_no_invalidation" {
  command = apply

  variables {
    aws_region               = "us-east-1"
    preview_retention_days   = 30
    github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    admin_github_subjects    = ["repo:example/admin:ref:refs/heads/main"]
    satellite_github_subjects = {
      sre = ["repo:example/sre:ref:refs/heads/main"]
    }
  }

  assert {
    condition     = aws_cloudfront_cache_policy.origin_respecting.id != aws_cloudfront_cache_policy.no_store.id
    error_message = "Policy IDs must be distinct for the reference assertions to mean anything."
  }

  assert {
    condition = (
      aws_cloudfront_cache_policy.origin_respecting.min_ttl == 0 &&
      aws_cloudfront_cache_policy.origin_respecting.default_ttl == 0 &&
      aws_cloudfront_cache_policy.origin_respecting.max_ttl == 31536000
    )
    error_message = "origin_respecting must be 0/0/31536000."
  }

  assert {
    condition = (
      aws_cloudfront_cache_policy.no_store.min_ttl == 0 &&
      aws_cloudfront_cache_policy.no_store.default_ttl == 0 &&
      aws_cloudfront_cache_policy.no_store.max_ttl == 0
    )
    error_message = "no_store must be 0/0/0."
  }

  assert {
    condition = (
      local.cache_behaviors.indexes.cache_policy_id == aws_cloudfront_cache_policy.origin_respecting.id &&
      local.cache_behaviors.artifacts.cache_policy_id == aws_cloudfront_cache_policy.origin_respecting.id &&
      local.cache_behaviors.previews.cache_policy_id == aws_cloudfront_cache_policy.origin_respecting.id &&
      local.cache_behaviors.assets.cache_policy_id == aws_cloudfront_cache_policy.origin_respecting.id
    )
    error_message = "indexes, artifacts, previews and assets must use origin_respecting."
  }

  assert {
    condition     = local.cache_behaviors.errors.cache_policy_id == aws_cloudfront_cache_policy.no_store.id
    error_message = "errors must use no_store."
  }

  assert {
    condition     = one(aws_cloudfront_distribution.site.default_cache_behavior).cache_policy_id == aws_cloudfront_cache_policy.origin_respecting.id
    error_message = "The default (app shell) behavior must use origin_respecting."
  }

  assert {
    condition = (
      !strcontains(aws_iam_role_policy.admin.policy, "cloudfront:") &&
      !strcontains(aws_iam_role_policy.satellite["sre"].policy, "cloudfront:") &&
      !strcontains(aws_iam_role_policy.admin.policy, "CreateInvalidation") &&
      !strcontains(aws_iam_role_policy.satellite["sre"].policy, "CreateInvalidation")
    )
    error_message = "No IAM policy may grant cloudfront:CreateInvalidation."
  }

  assert {
    condition = (
      strcontains(aws_iam_role_policy.admin.policy, "s3:PutObject") &&
      strcontains(aws_iam_role_policy.admin.policy, "s3:DeleteObject") &&
      strcontains(aws_iam_role_policy.satellite["sre"].policy, "s3:PutObject") &&
      strcontains(aws_iam_role_policy.satellite["sre"].policy, "s3:DeleteObject") &&
      one(data.aws_iam_policy_document.admin_trust.statement).actions == toset(["sts:AssumeRoleWithWebIdentity"]) &&
      one(data.aws_iam_policy_document.satellite_trust["sre"].statement).actions == toset(["sts:AssumeRoleWithWebIdentity"])
    )
    error_message = "Storage and OIDC statements must remain."
  }
}
