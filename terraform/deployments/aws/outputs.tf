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

output "hostname" {
  description = "DNS-only Cloudflare hostname routed to the CloudFront distribution."
  value       = module.artifact_pages.hostname
}

output "certificate_arn" {
  description = "Validated us-east-1 ACM certificate attached to CloudFront."
  value       = module.artifact_pages.certificate_arn
}

output "cloudflare_dns_records" {
  description = "Distribution and ACM validation record names managed in artifact-pages.stream."
  value       = module.artifact_pages.cloudflare_dns_records
}

output "admin_role_arn" {
  description = "GitHub OIDC admin role for the verification deployment."
  value       = module.artifact_pages.admin_role_arn
}

output "satellite_role_arns" {
  description = "GitHub OIDC publisher roles keyed by verification site ID."
  value       = module.artifact_pages.satellite_role_arns
}
