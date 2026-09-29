output "bucket_name" {
  description = "Private S3 origin bucket name."
  value       = module.artifact_pages.bucket_name
}

output "distribution_id" {
  description = "CloudFront distribution ID."
  value       = module.artifact_pages.distribution_id
}

output "distribution_domain_name" {
  description = "Default CloudFront hostname for the distribution."
  value       = module.artifact_pages.distribution_domain_name
}

output "aws_deployment_config_yaml" {
  description = "Non-secret Artifact Pages AWS deployment configuration."
  value       = module.artifact_pages.aws_deployment_config_yaml
}
