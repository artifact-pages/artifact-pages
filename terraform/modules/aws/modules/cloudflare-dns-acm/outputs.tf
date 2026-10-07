output "hostname" {
  description = "Cloudflare DNS hostname routed directly to CloudFront."
  value       = local.hostname
}

output "certificate_arn" {
  description = "Validated us-east-1 ACM viewer certificate ARN attached to the CloudFront distribution."
  value       = aws_acm_certificate_validation.viewer.certificate_arn
}

output "distribution_domain_name" {
  description = "CloudFront distribution hostname targeted by the DNS-only CNAME."
  value       = module.artifact_pages.distribution_domain_name
}

output "distribution_id" {
  description = "CloudFront distribution ID for the deployment configuration."
  value       = module.artifact_pages.distribution_id
}

output "bucket_name" {
  description = "Private S3 origin bucket name."
  value       = module.artifact_pages.bucket_name
}

output "admin_role_arn" {
  description = "GitHub OIDC role for registry, application, and administrative site operations."
  value       = module.artifact_pages.admin_role_arn
}

output "satellite_role_arns" {
  description = "Per-site GitHub OIDC role ARNs keyed by site ID."
  value       = module.artifact_pages.satellite_role_arns
}

output "aws_deployment_config_yaml" {
  description = "Provider-neutral artifact-pages AWS target configuration."
  value       = module.artifact_pages.aws_deployment_config_yaml
}

output "cloudflare_dns_records" {
  description = "Names of the CloudFront alias and ACM validation records owned in the selected Cloudflare zone."
  value = {
    distribution = cloudflare_dns_record.distribution.name
    validation   = { for key, record in cloudflare_dns_record.acm_validation : key => record.name }
  }
}
