# Local AWS module contract plan

This clean caller uses a local path so maintainers can validate the package before Registry publication. Its account ID, OIDC subjects, bucket override, and other values are placeholders; never apply its plan. The module can omit `bucket_name` and derives `artifact-pages-<AWS provider account ID>-<AWS region>` from the configured AWS provider identity and region. The validation suite uses Terraform's mocked AWS provider and account-identity data source, so it makes no AWS requests. For consumers, use the Registry source in [`examples/registry-consumer`](../registry-consumer) after publication.

For optional viewer policy, merge [waf.tfvars.example](waf.tfvars.example) with your inputs after selecting actual source IP ranges. See the [AWS WAF subset and ownership contract](../../docs/waf.md). Pre-plan checks are available through `scripts/validate-waf.sh` in the module repository.
