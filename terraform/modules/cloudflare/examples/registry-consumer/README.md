# Registry consumer example

This example pins an exact module version (the generated package sets it to that package's release) at `artifact-pages/artifact-pages/cloudflare`. The package repository has been generated and synced from the matching monorepo tag `terraform-cloudflare/vX.Y.Z`; each release is published on the public Terraform Registry. Do not replace it with a local path and treat that as Registry evidence.

Set the exact module version, supply real account/zone/hostname values in an untracked variable file, configure the provider through the environment, and run `terraform init`, `terraform validate`, and a reviewed `terraform plan`. Do not apply until the real plan, zone ownership, cost, and resource permissions are reviewed. The Cloudflare token needs `Config Rules Edit` in addition to the other ruleset permissions, because the module owns the zone's `http_config_settings` root; a zone that already has Configuration Rules must import it first (see the root README).
