# Registry consumer example

This example is ready for the intended Registry module address and candidate `0.1.0`. The owner has not approved or published that version, so `terraform init` cannot retrieve it yet. Do not replace the candidate with a local path and treat that as Registry evidence.

After explicit publication authorization and Registry listing, set the approved exact module version, supply real account/zone/hostname values in an untracked variable file, configure the provider through the environment, and run `terraform init`, `terraform validate`, and a reviewed `terraform plan`. Do not apply until the real plan, zone ownership, cost, and resource permissions are reviewed. The Cloudflare token needs `Config Rules Edit` in addition to the other ruleset permissions, because the module owns the zone's `http_config_settings` root; a zone that already has Configuration Rules must import it first (see the root README).
