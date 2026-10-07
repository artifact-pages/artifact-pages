output "aws_deployment_config_yaml" {
  description = "Non-secret Artifact Pages AWS deployment configuration."
  value       = module.artifact_pages.aws_deployment_config_yaml
}

output "distribution_domain_name" {
  description = "CloudFront hostname for DNS and browser checks."
  value       = module.artifact_pages.distribution_domain_name
}
