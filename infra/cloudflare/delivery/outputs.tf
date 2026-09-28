output "public_base_url" {
  description = "Base URL to set as cloudflare.publicBaseURL in the deployment config."
  value       = "https://${lower(var.public_hostname)}"
}

output "bucket_name" {
  description = "Existing R2 bucket connected to the public custom domain."
  value       = var.bucket_name
}
