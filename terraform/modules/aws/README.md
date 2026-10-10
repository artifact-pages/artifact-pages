# AWS reference deployment

This module provisions a private S3 origin and CloudFront distribution for the provider-neutral Artifact Pages projection. CloudFront reads the bucket through Origin Access Control; the bucket blocks public access. Explicit behaviors send storage and asset paths to S3; unmatched paths use the app shell through the viewer-request function. `/_control/*` has no content behavior, so its object keys are never requested from the origin and the path falls back to the app shell. A CloudFront response headers policy adds the trusted-HTML Content Security Policy and `X-Content-Type-Options: nosniff` to raw production artifact, raw preview and custom error responses. It permits HTTPS, blocks insecure HTTP, and grants no CORS access. Preview HTML stays on the application origin in an ordinary unsandboxed iframe: the iframe contains layout and CSS, while its scripts retain same-origin access to the parent DOM and storage.

The module also creates one admin GitHub OIDC role and one optional satellite role per site ID. The admin role can sync the registry, deploy or remove the application plane (`index.html`, `preview-bridge.js`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and `assets/*`), clean omitted site prefixes, update every control record under `_control/*`, and request CloudFront invalidations. Each satellite role reads the deployed registry and its site's current indexes, artifacts, and preview records, and can write only its site's artifacts, indexes, previews, retained site lock, site-cache and cache-retry records, private publish-state record, and exact preview-cleanup journal. GitHub OIDC subjects are exact inputs so a caller can restrict each role to selected branches or environments.

## Inputs

Create the GitHub OIDC provider in the AWS account first. The AWS provider configuration belongs to the caller, which can also pass assume-role, endpoint, and account-level settings. Set its region to the same value as `aws_region`.

| Name | Required | Default | Description |
| --- | --- | --- | --- |
| `bucket_name` | No | `null` | Optional S3 bucket name override. Defaults to `artifact-pages-<AWS provider account ID>-<AWS region>`. The S3 namespace is global; collisions fail without a random fallback. |
| `aws_region` | Yes | — | AWS region configured on the caller's `aws` provider and written to the deployment output. |
| `preview_retention_days` | Yes | — | Whole-number lifetime from 1 through 36500 for current and noncurrent `_previews/` objects. |
| `github_oidc_provider_arn` | Yes | — | ARN of the existing GitHub Actions OIDC provider. Its account ID must match the AWS provider target account. |
| `admin_github_subjects` | Yes | — | Exact GitHub OIDC `sub` claims allowed to assume the administrative role. |
| `satellite_github_subjects` | No | `{}` | Map of registered site IDs to exact `sub` claims for per-site publisher roles. |
| `name_prefix` | No | `artifact-pages` | Lowercase prefix for named AWS resources. |
| `github_oidc_issuer_url` | No | `https://token.actions.githubusercontent.com` | Issuer URL for the existing OIDC provider. |
| `aliases` | No | `[]` | Optional CloudFront alternate domain names. DNS is managed by the caller. |
| `acm_certificate_arn` | No | `null` | ACM certificate ARN in `us-east-1`, required when aliases are set. |
| `web_acl_arn` | No | `null` | Caller-owned global/us-east-1, same-account WAFv2 ACL; exclusive with `waf_custom_rules`. |
| `waf_custom_rules` | No | `null` | Module-owned AWS-native rules and IP allowlist preset; see [viewer policy](docs/waf.md). |
| `viewer_protocol_policy` | No | `redirect-to-https` | Redirect HTTP, or reject it with `https-only`, on every behavior; independent of WAF. |
| `price_class` | No | `PriceClass_100` | CloudFront edge location class. |
| `tags` | No | `{}` | Tags applied to supported resources. |

## GitHub OIDC subject claims

The admin and satellite role trust policies compare `token.actions.githubusercontent.com:sub` with `StringEquals`. Each subject input is an explicit allowlist: the module does not derive repository names, add wildcards, or infer the job's environment or ref. A list with both subject formats permits either exact string; include both only when both forms need to work during a migration.

For GitHub's default subject templates, a job that declares an environment uses a legacy name-based subject like `repo:OWNER/REPO:environment:ENVIRONMENT`; its immutable equivalent looks like `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:ENVIRONMENT`. For a job without an environment, the context may instead be a ref, such as `:ref:refs/heads/main`. Read the repository's configured prefix without changing settings with:

```sh
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq '.sub_claim_prefix'
```

When the repository uses GitHub's default subject template, append the job context, such as `:environment:aws-verify` or `:ref:refs/heads/main`, to that prefix and use the resulting exact claim. A custom subject template can replace the default format and change the context, so inspect the actual `sub` emitted by a controlled workflow instead of inferring it from the prefix. Immutable subjects include owner and repository IDs in the repo segment; see [GitHub's OIDC subject reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims). A custom template may optionally include `job_workflow_ref` to bind trust to a reusable workflow; the module leaves that choice to the caller.

## Outputs

| Name | Description |
| --- | --- |
| `bucket_name` | Private S3 origin bucket name. |
| `distribution_id` | CloudFront distribution ID for the deployment configuration. |
| `distribution_domain_name` | CloudFront distribution hostname for DNS and browser checks. |
| `admin_role_arn` | GitHub OIDC role for registry, application-plane, and administrative site operations. |
| `satellite_role_arns` | Per-site publisher role ARNs keyed by site ID. |
| `aws_deployment_config_yaml` | Non-secret AWS target configuration for the CLI. |

When `bucket_name` is omitted, the deterministic default uses the 12-digit account ID returned by `aws_caller_identity` for the configured AWS provider and `aws_region`. The module checks during planning that this account matches the account ID embedded in `github_oidc_provider_arn`, and stops on a mismatch before resources can be applied. This is a read-only AWS identity lookup; bucket-name availability is not guaranteed.

The module does not create DNS records. It creates a WAF policy only when `waf_custom_rules` is supplied; see [rule subset, ownership and retirement](docs/waf.md). A satellite role only exists for a key in `satellite_github_subjects`; registry edits do not change these permissions. Update the module inputs separately when repository identity or the intended site boundary changes.

## Optional Cloudflare DNS and ACM composition

The root AWS module remains AWS-only and keeps its generic custom-domain path: configure `aliases` and `acm_certificate_arn`, then manage DNS and the `us-east-1` certificate in your own Terraform configuration. Callers that use the default CloudFront hostname need no Cloudflare provider or certificate.

For callers that want Cloudflare-managed DNS for a custom AWS hostname, [`modules/cloudflare-dns-acm`](modules/cloudflare-dns-acm) composes this module with a caller-supplied Cloudflare zone and hostname plus an ACM certificate in `us-east-1`. It owns only the supplied non-apex hostname, its ACM DNS-validation CNAMEs, and a DNS-only CNAME to the resulting CloudFront distribution. It does not create a Route 53 zone or records, proxy traffic through Cloudflare, or manage the zone apex. The default AWS provider and its `us-east-1` alias must target the account in the supplied OIDC provider ARN; both identities are checked during planning. The [consumer example](examples/cloudflare-dns-acm-consumer) shows the required providers.

The composition is a separate source path with an additional Cloudflare provider requirement. Existing AWS-only callers do not inherit it. See its README for record import, certificate replacement, provider permissions, and plan review guidance.

Satellite IAM role names include the full site ID when they fit AWS's 64-character limit. Longer IDs use a stable hash suffix; `satellite_role_arns` remains keyed by the full site ID either way.

The CloudFront cache policies bound shared-cache freshness at 60 seconds for `/_indexes/*`, 300 seconds for `/_artifacts/*`, zero for the shell and `/_previews/*`, and honor per-object `Cache-Control` under `/assets/*` with a one-year maximum. Fixed-name assets revalidate; content-hashed assets can use the one-year immutable policy. A private S3 403 or 404 for a missing projection object maps to a 404 response. `/_errors/not-found.html` is a small managed text page used for that response.

The `artifact_csp` response headers policy is attached to the `/_artifacts/*`, `/_previews/*` and `/_errors/*` behaviors, so it covers normal artifact responses, raw preview responses and the custom not-found page returned for missing objects. Every ordered cache behavior redirects viewers to HTTPS (or rejects HTTP with `viewer_protocol_policy = "https-only"`), so `https:` covers both the artifact's own site path and other HTTPS origins. As specified in the [artifact viewer contract](../../../docs/specification.md#7-artifact-viewer), this intentionally allows same-origin paths and external HTTPS resources; publishing executable HTML remains the trust boundary. The policy preserves inline/eval script support, adds no `Access-Control-Allow-Origin`, and does not isolate the iframe or trusted preview JavaScript from the same-origin application. Because the policy is per behavior, it also applies to non-HTML objects under `/_previews/*`.

`preview_retention_days` expires current objects and noncurrent versions under `_previews/` through S3 lifecycle management, then removes expired delete markers. S3 versioning is bucket-wide rather than prefix-scoped; this module manages it as `Suspended` to avoid generating new unique versions for preview rewrites. The lifecycle rules also remove existing noncurrent preview versions if the bucket had been versioned before suspension. They do not alter noncurrent versions outside `_previews/`. Incomplete multipart uploads under the prefix are aborted after seven days.

S3 lifecycle processing is asynchronous. An expired object can remain readable for a period while S3 processes its lifecycle action, and a CDN or downstream cache can add further delay. CloudFront uses a zero-TTL policy for `/_previews/*`, but this does not make lifecycle expiration an exact-time revocation guarantee. Verify origin and viewer behavior in T4/T8/T15 after applying to a disposable provider target.

## Control-state permissions

The satellite role has `s3:GetObject` on `/_indexes/sites.json`, the selected site's `_indexes/<site>/*`, `_artifacts/<site>/*`, and `_previews/<site>/*` objects, and its own control prefix `_control/sites/<site>/*` (lock, site-cache, publish-state and preview-cleanup records). Its `s3:ListBucket` condition is restricted to selected-site prefixes and `_control/sites/<site>/*`. `s3:PutObject` is limited to the same selected-site object namespaces and control prefix. `s3:DeleteObject` is limited to `_artifacts/<site>/*`, `_indexes/<site>/*`, `_previews/<site>/*`, and `_control/sites/<site>/*`. A satellite never receives `_control/*` or another site's control prefix, and site identifiers cannot contain `/`, so per-site isolation comes from the key layout. Transitional (IMP-66): the role also keeps the exact pre-prefix keys `_control/locks/sites/<site>.json`, `_control/site-cache/<site>.json`, `_control/publish-state/<site>.json.gz` and `_control/preview-cleanup/<site>.json` so a CLI from before the layout change still works; apply this module release before upgrading the CLI, and a later release drops those keys. The preview delete grant is necessary for `preview remove` and does not include another site's previews. The index deletion grant lets reconciliation remove stale per-site metadata and generated full-text search objects; it does not include `/_indexes/sites.json`. The admin role has list/read/write/delete access to the whole `_control/*` prefix, so a new CLI control record needs no module change, plus the application bundle deletion scopes.

This module grants `cloudfront:CreateInvalidation` on the configured distribution. Review and reapply an older module's IAM policy before using the state-assisted publisher; do not broaden satellite storage access to another site, the registry, or the application plane. Invalidation permission is distribution-scoped in AWS IAM, while the CLI limits its requests to the selected site's changed content paths.

## Apply and configure the CLI

Use a reviewed `terraform plan` before applying. CloudFront distribution changes can take time to propagate. After apply, place the `aws_deployment_config_yaml` output in a local config or a pinned remote config file. Give the admin and satellite workflows their respective role ARNs; each workflow exchanges its GitHub OIDC token for temporary AWS credentials.

The generated AWS CLI configuration includes the effective bucket, its `accountId`, the region, and distribution ID; preview retention stays in Terraform lifecycle settings and is omitted from the CLI config. The module follows AWS's recommended signed OAC access for private S3 origins and uses a CloudFront response headers policy for the CSP. See [Restrict access to an Amazon S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), [Add or remove HTTP headers in CloudFront responses](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html), [CloudFront distribution Terraform resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_distribution.html), and [CloudFront cache behavior TTL guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/APIReference/API_DefaultCacheBehavior.html).

CloudFront routing, missing-object responses, IAM policy scope, effective browser headers, OIDC assumptions, and a live publish/unregister smoke still require deployment verification in T4, T14, and T15. This source module is not evidence that an AWS account has been configured correctly.

## Registry package and migration

The editable source of truth is `terraform/modules/aws` in the `artifact-pages/artifact-pages` monorepo. `artifact-pages/terraform-aws-artifact-pages` is a generated Registry package; do not edit its module source directly. The AWS module is versioned independently from Cloudflare and product releases.

The Registry address is `artifact-pages/artifact-pages/aws`. The first module version is `0.1.0`; its monorepo tag, generated package sync and Terraform Registry publication are still pending. An owner-approved `terraform-aws/vX.Y.Z` tag runs `.github/workflows/release-terraform.yml` and creates the corresponding immutable plain `vX.Y.Z` package tag. Connect and publish the exact version through Terraform Registry separately under IMP-38. AWS deployment and IAM enforcement remain unverified in T15.

Before Registry publication, verify that the generated package repository is public, its description is suitable for the Registry module listing, and the namespace is eligible. After the owner authorizes the exact module tag and sync, verify the generated package and immutable `vX.Y.Z` tag, connect the repository to Terraform Registry, publish the module, and retrieve that exact version in a clean external consumer. Do not push module source directly to the package repository or overwrite/move a published tag.

The former OSS `infra/aws` directory was a root Terraform configuration, not a child-module source, and the OSS repo has no checked-in caller module block for it. Existing root-config state therefore uses addresses such as `aws_s3_bucket.origin`; wrapping the package in `module "artifact_pages"` changes those to `module.artifact_pages.aws_s3_bucket.origin`. This is a state-address migration, not a source-only change. Back up state and list and review every AWS resource and data address owned by that root configuration. Perform the migration in the same backend and workspace that contain the old state. If the configuration moves to a different directory, initialize it against that same backend/workspace; for local state, explicitly transfer the saved state into the new working directory before moving addresses. Never run `state mv` against a fresh empty local state. After confirming the target state, update the configuration to call this module and run `terraform init`; Terraform must be initialized before the address moves. Then move each address under the module path before planning. For example:

```sh
terraform state mv 'aws_s3_bucket.origin' 'module.artifact_pages.aws_s3_bucket.origin'
```

Repeat for each resource and data source from the former root configuration using its exact current and new address. Do not move unrelated resources in a shared state. A no-move source-only migration applies only to a caller that already wrapped the old implementation in a Terraform module; no such caller is present in this OSS repository. After the moves, inspect a fresh plan for address changes, replacements, and IAM differences, and keep the backup until the migration is accepted. Changing a module source or reverting the source ref does not roll back infrastructure state.

The local caller and validation script are not deployment authorization. The script checks formatting, backend-free initialization, validation, the role/cache/lifecycle source contract, and mocked Terraform plans whose evaluated deployment YAML is passed to the OSS CLI config parser for both the default bucket and an explicit override. Separate mocked mismatch plans verify that the core module and the Cloudflare/ACM wrapper reject AWS provider accounts that differ from the OIDC account. The OIDC subject test uses synthetic AWS credentials and overrides caller identity while calculating the policy document locally; the remaining provider checks use mocks. Validation makes no real provider API calls.
