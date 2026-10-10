# Optional AWS + Cloudflare DNS and ACM composition

This child module composes the AWS deployment module with DNS-only Cloudflare records for one caller-selected custom hostname. It accepts any valid non-apex hostname beneath the supplied Cloudflare zone. The root AWS module only requires the AWS provider and continues to support the default CloudFront hostname or a caller-managed certificate and DNS configuration.

The caller must configure the default AWS provider in `aws_region`, an `aws.us_east_1` alias, and the Cloudflare provider. Both AWS provider configurations must target the account embedded in `github_oidc_provider_arn`; the module checks both identities during planning and stops on a mismatch before any resource can be applied. These are read-only AWS identity lookups. The alias creates and validates the ACM viewer certificate in `us-east-1`, as [CloudFront requires](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html). The module creates DNS validation records first and passes the validated certificate ARN and the same hostname to the AWS module's `aliases` and `acm_certificate_arn` inputs. This dependency makes certificate validation complete before the CloudFront distribution can use the alias.

The Cloudflare zone must already exist. `cloudflare_domain.hostname` must be a valid subdomain beneath `cloudflare_domain.zone_name`; the apex is rejected. The module creates only:

- DNS-only ACM validation CNAMEs in the supplied Cloudflare zone (`proxied = false`, automatic TTL).
- One DNS-only CNAME from the supplied hostname to the CloudFront distribution (`proxied = false`, automatic TTL).

It does not create Route 53 resources, change unrelated DNS names, manage the zone or nameservers, or proxy CloudFront traffic through Cloudflare. The apex product delivery path is independent and is not configured by this module.

## Inputs and outputs

The deployment inputs mirror the [root AWS module](../../README.md#inputs), including `waf_custom_rules`, `web_acl_arn` and the independent `viewer_protocol_policy`, with `cloudflare_domain` added. WAF enforcement is on CloudFront; see the [AWS policy contract](../../docs/waf.md).

Additional domain inputs:

| Name | Required | Description |
| --- | --- | --- |
| `cloudflare_domain.zone_id` | Yes | ID of the existing Cloudflare zone. |
| `cloudflare_domain.zone_name` | Yes | DNS name of that zone, used to validate the hostname boundary. |
| `cloudflare_domain.hostname` | Yes | One non-apex hostname within the zone. |

The module returns the root AWS deployment outputs plus `hostname`, `certificate_arn`, and `cloudflare_dns_records`. Credentials and provider configuration stay in the caller. The Cloudflare token needs `Zone > DNS > Edit` scoped to the supplied zone; DNS Edit includes the read/list access needed to refresh these records. This module receives the existing zone ID as input and does not perform a zone lookup, so it does not need Zone Read. The AWS identity needs the permissions required by the root module and ACM in `us-east-1`.

## Existing records and replacement

This module takes Terraform ownership of its Cloudflare DNS records. If a matching record is already managed by another Terraform state, coordinate ownership before applying. For an existing record that should move into this state, import it instead of creating a duplicate. With Cloudflare provider 5.x, the import ID is `<zone_id>/<dns_record_id>`. Assuming the caller's module block is named `artifact_pages` and its hostname is `www.example.com`:

```sh
terraform import 'module.artifact_pages.cloudflare_dns_record.distribution' '<zone_id>/<dns_record_id>'
terraform import 'module.artifact_pages.cloudflare_dns_record.acm_validation["www.example.com"]' '<zone_id>/<dns_record_id>'
```

The ACM validation address uses the certificate validation option's domain name as its `for_each` key. Replace the example key with the configured hostname, and confirm the actual key and record IDs in the plan and Cloudflare dashboard before importing. The [Cloudflare provider import reference](https://github.com/cloudflare/terraform-provider-cloudflare/blob/main/docs/resources/dns_record.md#import) documents the provider ID format.

The ACM certificate uses `create_before_destroy`; a hostname change requests and validates the replacement certificate while the current certificate remains available. The matching CloudFront alias and CNAME then update through Terraform. Review the plan for both certificates, the distribution update, and DNS changes before applying. Certificate and CloudFront propagation take time, and reverting the Terraform source does not reverse DNS or certificate changes already applied.

## Real-plan review checklist

Before an approved plan for a configured hostname, verify the caller's AWS default provider points to the intended account and `aws_region`, while `aws.us_east_1` points to the same account in `us-east-1`. Both accounts must match the account in `github_oidc_provider_arn`. Confirm the Cloudflare token and `cloudflare_domain.zone_id` refer to the zone identified by `cloudflare_domain.zone_name`. Review the full plan and check that:

- The requested ACM certificate's domain is exactly the normalized `cloudflare_domain.hostname`, and the certificate validation waiter completes before the CloudFront distribution uses it.
- The ACM validation records are CNAMEs in the selected Cloudflare zone with `proxied = false` and automatic TTL.
- There is one distribution CNAME for `cloudflare_domain.hostname`, it points to the planned CloudFront distribution hostname, and it has `proxied = false` and automatic TTL.
- The CloudFront alias is exactly `cloudflare_domain.hostname` and its viewer certificate ARN is the validated `us-east-1` certificate.
- The plan contains no Route 53 resources, apex record, unrelated Cloudflare records, or unreviewed AWS replacements and deletions.

After a separately approved apply, wait for ACM `ISSUED` and CloudFront `Deployed`, then verify the DNS-only CNAME resolves to the distribution hostname, TLS succeeds for `cloudflare_domain.hostname`, and the browser can load the deployed site. These checks are live T15 proof; the local validation script does not perform them.

## Validation boundary

The local examples use placeholder values. Validation mocks AWS and Cloudflare providers, including both AWS identity lookups, and does not contact provider APIs or apply resources. It verifies source wiring and rejects mocked account mismatches; it does not prove DNS validation, certificate issuance, CloudFront deployment, or browser delivery. Those require a separately approved plan and a live disposable target.
