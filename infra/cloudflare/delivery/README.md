# Cloudflare delivery reference

This module connects an **existing R2 bucket** to a public custom domain and configures the Cloudflare edge rules used by Artifact Pages. It does not create the bucket, configure preview lifecycle expiration, mint R2 credentials, create a Cloudflare Access application, or publish application/site objects. The [Cloudflare caller example](../../../examples/cloudflare/terraform) composes this delivery module with [the separate retention module](../retention/README.md) for preview expiration after reviewing its complete-rule-set ownership.

The module manages three zone phase-root rulesets: `http_request_transform`, `http_request_firewall_custom`, and `http_request_cache_settings`. A phase has one root ruleset. Before first use, inspect the zone for each phase. If a root ruleset already exists, import it into the matching Terraform resource (for example, `terraform import 'module.artifact_pages_delivery.cloudflare_ruleset.logical_routes' 'zones/<zone-id>/<ruleset-id>'`) and pass its complete rules through `existing_transform_rules`, `existing_firewall_rules`, or `existing_cache_rules` in their existing execution order. These variables default to empty lists; applying them without preserving existing rules can remove rules managed elsewhere. Review the plan for each complete ruleset before applying.

The route rule sends `/` and non-reserved application paths to `/index.html`, preserving the browser URL. It decodes and lowercases the request path for reserved-path matching, so encoded or case-varied forms of `/_control` are not sent to the SPA shell. `/index.html`, `/preview-bridge.js`, `/assets/*`, `/_indexes/*`, `/_artifacts/*`, `/_previews/*`, and `/_control/*` bypass that rewrite so missing storage objects remain missing. The firewall rule blocks the decoded exact `/_control` root and descendants. The cache rule applies only to the published application/content paths, marks responses eligible, and uses `respect_origin` for both edge and browser TTL so the publisher's path-specific `Cache-Control` remains authoritative. Existing transform rules must not rewrite reserved object paths or overwrite the application route rewrite; existing cache rules must not apply a later, longer TTL to these paths.

The public R2 custom domain is enabled with TLS 1.2 by default. The provider does not support importing an existing `cloudflare_r2_custom_domain`; for a hostname already connected to this bucket, set `connect_custom_domain = false` and verify the existing hostname is enabled with the intended TLS setting. The module also disables the bucket's managed `r2.dev` domain so it cannot provide a second public path. Verify both resource states after the first apply. The provider does not support importing or destroying `cloudflare_r2_managed_domain`; Terraform warns that removing this resource from state/config does not change the remote setting. Manage that setting in one Terraform state and change its `enabled` value explicitly if the policy needs to change. Restricting the public host with Cloudflare Access is an optional, separately managed viewer policy; this module does not configure user identity or per-site authorization.

## Calling module

```hcl
module "artifact_pages_delivery" {
  source = "./infra/cloudflare/delivery"

  account_id      = var.cloudflare_account_id
  zone_id         = var.cloudflare_zone_id
  bucket_name     = var.r2_bucket_name
  public_hostname = "artifacts.example.com"
  # Set false when the custom domain is already connected; this resource cannot be imported.
  connect_custom_domain = true
}
```

Configure the Cloudflare Terraform provider with an API token outside source control. Grant only the R2 custom/managed domain and zone Rulesets permissions required by the resources, including read access when importing or reconciling existing rulesets. Do not reuse the R2 S3 access key as a Cloudflare API token.

## Limits and evidence

Cloudflare's R2 custom domain and Rulesets API apply at the zone edge. This module has only been validated as Terraform source; a clean caller must still import/reconcile existing root rulesets, review a credentialed plan, apply it, and run the deployed route/cache/control-boundary smoke. Configure Access separately when required and verify that it challenges both cold and warm requests. The local adapter profile does not prove Cloudflare's deployed routing, caching, purge propagation, or authorization behavior.

References: [Cloudflare Transform Rules with Terraform](https://developers.cloudflare.com/terraform/additional-configurations/transform-rules/), [Cache Rules with Terraform](https://developers.cloudflare.com/cache/how-to/cache-rules/terraform-example/), [R2 public custom domains](https://developers.cloudflare.com/r2/buckets/public-buckets/), [R2 custom and managed domains](https://developers.cloudflare.com/api/terraform/resources/r2/), [Terraform R2 custom-domain resource](https://registry.terraform.io/providers/cloudflare/cloudflare/5.24.0/docs/resources/r2_custom_domain), [Terraform R2 managed-domain resource](https://registry.terraform.io/providers/cloudflare/cloudflare/5.24.0/docs/resources/r2_managed_domain), [R2 custom-domain API](https://developers.cloudflare.com/api/terraform/resources/r2/subresources/buckets/subresources/domains/subresources/custom/), and [Ruleset phases](https://developers.cloudflare.com/ruleset-engine/reference/phases-list/).
