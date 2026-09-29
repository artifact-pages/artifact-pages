# Cloudflare Terraform caller

This Cloudflare R2 caller is under evaluation alongside the AWS CloudFront caller in [`terraform/aws`](../aws). It consumes the sibling module checkout through a relative path. Generate a fresh plan after module changes. The Cloudflare provider needs `CLOUDFLARE_API_TOKEN` for authenticated zone-ruleset checks; warnings about missing authorization mean the plan has not been verified against the live zone.

This apprepo caller consumes the sibling `terraform-cloudflare-artifact-pages` checkout through a relative module source. Keep account, zone, hostname, and retention values in the ignored local `terraform.tfvars`; `r2_bucket_name` is an optional override and defaults to `artifact-pages` within the selected Cloudflare account. The committed `terraform.tfvars.example` uses deliberately invalid ID markers and generic hostname/bucket placeholders.

The root module creates a new R2 bucket and manages delivery rules, the custom-domain connection, and the bucket's complete preview lifecycle configuration. It has a separate local Terraform state from the older `examples/cloudflare/terraform` caller. Before using this against a real account, confirm the selected bucket is new or migrate the existing resources and state using the module repository's migration guide. Review existing zone rulesets and any custom-domain connection before applying.

Run from the apprepo root after copying the example, filling the local variable file, and configuring `CLOUDFLARE_API_TOKEN` in the environment:

```sh
mkdir -p .local/terraform/cloudflare
cp -n terraform/cloudflare/terraform.tfvars.example terraform/cloudflare/terraform.tfvars
# Edit terraform/cloudflare/terraform.tfvars with the real account, zone, bucket, and retention values.
terraform -chdir=terraform/cloudflare init
terraform -chdir=terraform/cloudflare plan -var-file=terraform.tfvars
```

The local backend stores state under the ignored `.local/` directory. `terraform.tfvars`, state files, and saved `*.tfplan` files are ignored by the apprepo `.gitignore`. Keep credential values out of Terraform variables and files. `preview_retention_days` is configured and enforced only through the Terraform lifecycle policy; it is not part of the CLI deployment configuration. R2 lifecycle expiration is asynchronous.

The module's `artifact_pages_deployment_config_yaml` output omits CLI-default environment names and registry-reader fields in the normal configuration. To opt into a delegated publisher, set the optional `registry_reader` object in the local `terraform.tfvars`; it accepts the reader access-key and secret environment names, plus an optional session-token environment name for temporary credentials.
