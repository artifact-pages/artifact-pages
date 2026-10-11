mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
      arn        = "arn:aws:iam::123456789012:root"
      user_id    = "AIDAROLENAMES"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"AWS\":\"*\"}}]}"
    }
  }
}

run "satellite_role_names_match_cli_contract_fixture" {
  command = plan

  variables {
    name_prefix              = jsondecode(file("tests/fixtures/satellite-role-names.json")).namePrefix
    aws_region               = "us-east-1"
    preview_retention_days   = 30
    github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    admin_github_subjects    = ["repo:example/admin:ref:refs/heads/main"]
    satellite_github_subjects = {
      for item in jsondecode(file("tests/fixtures/satellite-role-names.json")).cases :
      item.siteID => ["repo:example/${item.siteID}:ref:refs/heads/main"]
    }
  }

  assert {
    condition = alltrue([
      for item in jsondecode(file("tests/fixtures/satellite-role-names.json")).cases :
      local.satellite_role_names[item.siteID] == item.roleName
    ])
    error_message = "Terraform satellite role names must match the shared CLI contract fixture at and above AWS's 64-character limit."
  }
}
