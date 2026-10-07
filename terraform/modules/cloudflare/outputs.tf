output "bucket_name" {
  description = "Name of the R2 bucket shared by delivery and preview retention."
  value       = cloudflare_r2_bucket.origin.name
}

output "public_base_url" {
  description = "Public custom-domain base URL to set as cloudflare.publicBaseURL in the Artifact Pages deployment configuration."
  value       = module.delivery.public_base_url
}

output "artifact_pages_deployment_config_yaml" {
  description = "Non-secret Artifact Pages deployment configuration. It omits default credential environment-variable names and includes only non-default names, never credential values."
  value = yamlencode({
    schemaVersion = 1
    provider      = "cloudflare"
    cloudflare = merge(
      {
        accountId     = var.account_id
        bucket        = cloudflare_r2_bucket.origin.name
        zoneId        = var.zone_id
        publicBaseURL = module.delivery.public_base_url
      },
      var.access_key_id_env == "CF_R2_ACCESS_KEY_ID" ? {} : { accessKeyIdEnv = var.access_key_id_env },
      var.secret_access_key_env == "CF_R2_SECRET_ACCESS_KEY" ? {} : { secretAccessKeyEnv = var.secret_access_key_env },
      var.api_token_env == "CF_API_TOKEN" ? {} : { apiTokenEnv = var.api_token_env },
      var.registry_reader == null ? {} : merge(
        {
          registryReaderAccessKeyIdEnv     = var.registry_reader.access_key_id_env
          registryReaderSecretAccessKeyEnv = var.registry_reader.secret_access_key_env
        },
        var.registry_reader.session_token_env == null ? {} : { registryReaderSessionTokenEnv = var.registry_reader.session_token_env },
      ),
    )
  })
}
