output "hostname" {
  value = module.artifact_pages.hostname
}

output "distribution_domain_name" {
  value = module.artifact_pages.distribution_domain_name
}

output "certificate_arn" {
  value = module.artifact_pages.certificate_arn
}

output "aws_deployment_config_yaml" {
  value = module.artifact_pages.aws_deployment_config_yaml
}
