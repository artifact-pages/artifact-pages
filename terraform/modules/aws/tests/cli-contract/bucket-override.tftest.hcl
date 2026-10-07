mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "000000000000"
      arn        = "arn:aws:iam::000000000000:root"
      user_id    = "AIDACONTRACTTEST"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"AWS\":\"*\"}}]}"
    }
  }

  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      id = "E0000000000000"
    }
  }

  mock_resource "aws_cloudfront_function" {
    defaults = {
      arn  = "arn:aws:cloudfront::000000000000:function/artifact-pages-contract"
      id   = "artifact-pages-contract"
      name = "artifact-pages-contract"
    }
  }
}

run "bucket_override_output_parses_in_cli" {
  command = apply

  variables {
    bucket_name     = "artifact-pages-contract-override"
    expected_bucket = "artifact-pages-contract-override"
  }

  assert {
    condition     = data.external.cli_contract.result["provider"] == "aws"
    error_message = "the evaluated AWS module output must parse as an AWS CLI target"
  }

  assert {
    condition     = data.external.cli_contract.result["bucket"] == "artifact-pages-contract-override"
    error_message = "the parsed CLI target must contain the explicit effective bucket"
  }

  assert {
    condition     = module.artifact_pages.bucket_name == "artifact-pages-contract-override"
    error_message = "the Terraform plan must configure the S3 bucket with the explicit override"
  }
}
