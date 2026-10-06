output "bucket_name" {
  description = "Created R2 bucket name."
  value       = module.artifact_pages.bucket_name
}

output "public_base_url" {
  description = "Public base URL for the Artifact Pages deployment configuration."
  value       = module.artifact_pages.public_base_url
}

output "artifact_pages_deployment_config_yaml" {
  description = "Non-secret Artifact Pages target YAML."
  value       = module.artifact_pages.artifact_pages_deployment_config_yaml
}
