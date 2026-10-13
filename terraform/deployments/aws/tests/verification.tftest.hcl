mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "231136241959"
      arn        = "arn:aws:iam::231136241959:root"
      user_id    = "AIDAVERIFICATIONTEST"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = jsonencode({
        Version   = "2012-10-17"
        Statement = []
      })
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      domain_name    = "dverification.cloudfront.net"
      hosted_zone_id = "Z2FDTNDATAQYW2"
      id             = "E0123456789ABC"
    }
  }
}

run "disposable_default_hostname_plan" {
  command = plan

  variables {
    admin_github_subjects     = ["repo:artifact-pages@338198830/admin@1402509181:environment:aws-verify"]
    satellite_github_subjects = { aws-verify = ["repo:artifact-pages@338198830/docs@1402509222:environment:aws-verify"] }
  }

  assert {
    condition     = output.distribution_domain_name == "dverification.cloudfront.net"
    error_message = "the verification plan must use the default CloudFront hostname"
  }

  assert {
    condition     = output.distribution_hosted_zone_id == "Z2FDTNDATAQYW2"
    error_message = "the verification plan must expose the CloudFront hosted zone ID"
  }

  assert {
    condition     = keys(output.satellite_role_arns) == ["aws-verify"]
    error_message = "the plan must create only the disposable aws-verify satellite role"
  }
}
