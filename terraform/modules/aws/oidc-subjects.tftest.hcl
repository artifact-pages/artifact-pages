provider "aws" {
  # Synthetic credentials configure the provider; the plan overrides caller identity and makes no AWS requests.
  access_key                  = "test-access-key"
  secret_key                  = "test-secret-key"
  region                      = "us-east-1"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
    arn        = "arn:aws:iam::123456789012:root"
    user_id    = "AIDATESTSUBJECTS"
  }
}

run "legacy_and_immutable_subjects_remain_exact" {
  command = plan

  variables {
    aws_region               = "us-east-1"
    preview_retention_days   = 30
    github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    admin_github_subjects = [
      "repo:example/admin:environment:production",
      "repo:example@123456789/admin@1234567890:environment:production",
    ]
    satellite_github_subjects = {
      sre = [
        "repo:example/sre:ref:refs/heads/main",
        "repo:example@123456789/sre@1234567891:ref:refs/heads/main",
      ]
    }
  }

  assert {
    condition = (
      jsondecode(data.aws_iam_policy_document.admin_trust.json).Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ] == "sts.amazonaws.com" &&
      toset(jsondecode(data.aws_iam_policy_document.admin_trust.json).Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
        ]) == toset([
        "repo:example/admin:environment:production",
        "repo:example@123456789/admin@1234567890:environment:production",
      ])
    )
    error_message = "admin trust must preserve the exact audience and only the explicitly listed legacy and immutable subjects"
  }

  assert {
    condition = (
      jsondecode(data.aws_iam_policy_document.satellite_trust["sre"].json).Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:aud"
      ] == "sts.amazonaws.com" &&
      toset(jsondecode(data.aws_iam_policy_document.satellite_trust["sre"].json).Statement[0].Condition.StringEquals[
        "token.actions.githubusercontent.com:sub"
        ]) == toset([
        "repo:example/sre:ref:refs/heads/main",
        "repo:example@123456789/sre@1234567891:ref:refs/heads/main",
      ])
    )
    error_message = "satellite trust must preserve the exact audience and only the explicitly listed legacy and immutable subjects"
  }
}
