output "bucket_name" {
  description = "Private S3 origin bucket name."
  value       = aws_s3_bucket.origin.id
}

output "distribution_id" {
  description = "CloudFront distribution ID for the deployment config."
  value       = aws_cloudfront_distribution.site.id
}

output "distribution_domain_name" {
  description = "CloudFront domain name for DNS and browser testing."
  value       = aws_cloudfront_distribution.site.domain_name
}

output "admin_role_arn" {
  description = "GitHub OIDC role for registry, application, and administrative site operations."
  value       = aws_iam_role.admin.arn
}

output "satellite_role_arns" {
  description = "Per-site GitHub OIDC roles restricted to each configured site's storage prefixes."
  value       = { for site_id, role in aws_iam_role.satellite : site_id => role.arn }
}

output "aws_deployment_config_yaml" {
  description = "Provider-neutral artifact-pages AWS target configuration."
  value = yamlencode({
    schemaVersion = 1
    provider      = "aws"
    aws = {
      region         = var.aws_region
      bucket         = aws_s3_bucket.origin.id
      distributionId = aws_cloudfront_distribution.site.id
    }
  })
}
