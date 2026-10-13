output "bucket_name" {
  description = "Private S3 origin bucket name."
  value       = module.artifact_pages.bucket_name
}

output "distribution_id" {
  description = "CloudFront distribution ID."
  value       = module.artifact_pages.distribution_id
}

output "distribution_domain_name" {
  description = "Default CloudFront hostname; the verification deployment is reached at this name."
  value       = module.artifact_pages.distribution_domain_name
}

output "distribution_hosted_zone_id" {
  description = "CloudFront hosted zone ID for Route 53 alias records (A and AAAA)."
  value       = module.artifact_pages.distribution_hosted_zone_id
}

output "aws_deployment_config_yaml" {
  description = "Non-secret Artifact Pages AWS deployment configuration."
  value       = module.artifact_pages.aws_deployment_config_yaml
}

output "admin_role_arn" {
  description = "GitHub OIDC admin role for the verification deployment."
  value       = module.artifact_pages.admin_role_arn
}

output "satellite_role_arns" {
  description = "GitHub OIDC publisher roles keyed by verification site ID."
  value       = module.artifact_pages.satellite_role_arns
}
