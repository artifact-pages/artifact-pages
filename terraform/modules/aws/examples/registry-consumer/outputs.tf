output "aws_deployment_config_yaml" {
  description = "Non-secret Artifact Pages AWS deployment configuration."
  value       = module.artifact_pages.aws_deployment_config_yaml
}
