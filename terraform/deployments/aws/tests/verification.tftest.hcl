mock_provider "aws" {
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "231136241959"
      arn        = "arn:aws:iam::231136241959:root"
      user_id    = "AIDAVERIFICATIONTEST"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:231136241959:certificate/verification"
      domain_validation_options = [
        {
          domain_name           = "aws.artifact-pages.stream"
          resource_record_name  = "_verification.aws.artifact-pages.stream."
          resource_record_type  = "CNAME"
          resource_record_value = "_verification.acm-validations.aws."
        }
      ]
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      domain_name = "dverification.cloudfront.net"
      id          = "E0123456789ABC"
    }
  }
}

mock_provider "aws" {
  alias           = "us_east_1"
  override_during = plan

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "231136241959"
      arn        = "arn:aws:iam::231136241959:root"
      user_id    = "AIDAVERIFICATIONTEST"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:231136241959:certificate/verification"
      domain_validation_options = [
        {
          domain_name           = "aws.artifact-pages.stream"
          resource_record_name  = "_verification.aws.artifact-pages.stream."
          resource_record_type  = "CNAME"
          resource_record_value = "_verification.acm-validations.aws."
        }
      ]
    }
  }
}

mock_provider "cloudflare" {}

run "disposable_dns_acm_plan" {
  command = plan

  variables {
    cloudflare_zone_id        = "11111111111111111111111111111111"
    admin_github_subjects     = ["repo:artifact-pages@338198830/admin@1402509181:environment:aws-verify"]
    satellite_github_subjects = { aws-verify = ["repo:artifact-pages@338198830/docs@1402509222:environment:aws-verify"] }
  }

  assert {
    condition     = output.hostname == "aws.artifact-pages.stream"
    error_message = "the verification plan must configure the selected aws.artifact-pages.stream hostname"
  }

  assert {
    condition     = output.certificate_arn != ""
    error_message = "the plan must configure the ACM validation output"
  }

  assert {
    condition     = output.cloudflare_dns_records.distribution == "aws.artifact-pages.stream" && length(output.cloudflare_dns_records.validation) == 1
    error_message = "the plan must configure one ACM validation CNAME and the selected distribution CNAME"
  }

  assert {
    condition     = keys(output.satellite_role_arns) == ["aws-verify"]
    error_message = "the plan must create only the disposable aws-verify satellite role"
  }
}
