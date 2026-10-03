# Cloudflare Terraform caller

This Cloudflare R2 caller is under evaluation alongside the AWS CloudFront caller in [AWS deployment root](../aws). It consumes the sibling module checkout through a relative path. Generate a fresh plan after module changes. The Cloudflare provider needs `CLOUDFLARE_API_TOKEN` for authenticated zone-ruleset checks; warnings about missing authorization mean the plan has not been verified against the live zone.

This local consumer root consumes the sibling `terraform-cloudflare-artifact-pages` checkout through a relative module source. The in-repository delivery/retention modules and their example caller under `terraform/modules/cloudflare` and `examples/cloudflare/terraform` are a separate source/release boundary. Keep account, zone, hostname, and retention values in the ignored local `terraform.tfvars`; `r2_bucket_name` is an optional override and defaults to `artifact-pages` within the selected Cloudflare account. The committed `terraform.tfvars.example` uses deliberately invalid ID markers and generic hostname/bucket placeholders.

The root module creates a new R2 bucket and manages delivery rules, the custom-domain connection, and the bucket's complete preview lifecycle configuration. It has a separate local Terraform state from the older `examples/cloudflare/terraform` caller. Before using this against a real account, confirm the selected bucket is new or migrate the existing resources and state using the module repository's migration guide. Review existing zone rulesets and any custom-domain connection before applying.

Run from the apprepo root after copying the example, filling the local variable file, and configuring `CLOUDFLARE_API_TOKEN` in the environment:

```sh
mkdir -p .local/terraform/cloudflare
cp -n terraform/deployments/cloudflare/terraform.tfvars.example terraform/deployments/cloudflare/terraform.tfvars
# Edit terraform/deployments/cloudflare/terraform.tfvars with the real account, zone, bucket, and retention values.
terraform -chdir=terraform/deployments/cloudflare init
terraform -chdir=terraform/deployments/cloudflare plan -var-file=terraform.tfvars
```

The local backend stores state under the ignored `.local/` directory. `terraform.tfvars`, state files, and saved `*.tfplan` files are ignored by the apprepo `.gitignore`. Keep credential values out of Terraform variables and files. `preview_retention_days` is configured and enforced only through the Terraform lifecycle policy; it is not part of the CLI deployment configuration. R2 lifecycle expiration is asynchronous.

The module's `artifact_pages_deployment_config_yaml` output omits CLI-default environment names and registry-reader fields in the normal configuration. To opt into a delegated publisher, set the optional `registry_reader` object in the local `terraform.tfvars`; it accepts the reader access-key and secret environment names, plus an optional session-token environment name for temporary credentials.

Optional viewer-edge WAF configuration is passed through `waf_custom_rules` to the authoritative module. Keep actual source-network CIDRs in the ignored local variable file. For example:

```hcl
waf_custom_rules = {
  presets = {
    https_only   = true
    ip_allowlist = ["192.0.2.10/32"] # Replace with the operator's current public IPv4 address.
  }
}
```

Enabled presets compile into one hostname-scoped Block rule: a viewer request must use HTTPS on port 443 and originate from an allowed network. The allowlist is static; recheck it when the operator's network changes. IPv6 requires its own explicitly allowed CIDR. The presets apply to logical routes and raw app/index/artifact/preview objects, and do not configure authentication or HTTP-to-HTTPS redirects. Provider-native additional rules may be supplied through `rules`.

Omitting `waf_custom_rules` leaves WAF unmanaged. Before enabling against a zone with an existing custom-WAF entrypoint, follow the module's import, complete-rule-preservation and single-state ownership instructions. A fresh plan alone does not establish live enforcement or account entitlement compatibility. Review the full plan, including unrelated pre-existing drift. Set `enabled = false` within the WAF object to disable module-added rules in place; returning a managed object to null is a state-handoff operation, not an emergency disable. This caller does not pass WAF settings into CLI deployment YAML. Applying the saved plan requires a separate operator decision.
