# AWS reference deployment

This module provisions a private S3 origin and CloudFront distribution for the provider-neutral Artifact Pages projection. CloudFront reads the bucket through Origin Access Control; the bucket blocks public access. Explicit behaviors pass app and content paths through to S3; unmatched paths use the viewer-request function to load `/index.html`. `/_control/*` has no content behavior, so its object keys are never requested from the origin and those URLs fall back to the app shell.

The module also creates one admin GitHub OIDC role and one optional satellite role per site ID. The admin role can apply the registry, publish the application plane (`index.html`, `preview-bridge.js`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and `assets/*`), clean removed site prefixes, update registry control records, and request CloudFront invalidations. Each satellite role reads the deployed registry and its site's current indexes, artifacts, and preview records, and can write only its site's artifacts, indexes, previews, and retained site lock. GitHub OIDC subjects are exact inputs so a caller can restrict each role to selected branches or environments.

## Inputs

Create the GitHub OIDC provider in the AWS account first. Then provide:

- `aws_region` and globally unique `bucket_name`.
- `preview_retention_days`, the single provider-managed lifecycle duration for the complete `_previews/` prefix.
- Optional `price_class` to select CloudFront edge locations (`PriceClass_100` by default).
- `github_oidc_provider_arn` and exact `admin_github_subjects`.
- `satellite_github_subjects`, keyed by registered site ID, with exact GitHub OIDC subject claims.
- Optional `aliases` plus an ACM certificate ARN in `us-east-1`, and optional customer-managed `web_acl_arn`.

The module does not create DNS records or a WAF policy. A satellite role only exists for a key in `satellite_github_subjects`; registry edits do not change these permissions. Update the module inputs separately when repository identity or the intended site boundary changes.

Satellite IAM role names include the full site ID when they fit AWS's 64-character limit. Longer IDs use a stable hash suffix; `satellite_role_arns` remains keyed by the full site ID either way.

The CloudFront cache policies bound shared-cache freshness at 60 seconds for `/_indexes/*`, 300 seconds for `/_artifacts/*`, zero for the shell and `/_previews/*`, and honor the publisher's per-object `Cache-Control` under `/assets/*` with a one-year maximum. Fixed-name assets revalidate; content-hashed assets can use the one-year immutable policy. A private S3 403 or 404 for a missing projection object maps to a 404 response. `/_errors/not-found.html` is a small managed text page used for that response.

`preview_retention_days` expires current objects and noncurrent versions under `_previews/` through S3 lifecycle management, then removes expired delete markers. S3 versioning is bucket-wide rather than prefix-scoped; this module manages it as `Suspended` to avoid generating new unique versions for preview rewrites. The lifecycle rules also remove existing noncurrent preview versions if the bucket had been versioned before suspension. They do not alter noncurrent versions outside `_previews/`. Incomplete multipart uploads under the prefix are aborted after seven days.

S3 lifecycle processing is asynchronous. An expired object can remain readable for a period while S3 processes its lifecycle action, and a CDN or downstream cache can add further delay. CloudFront uses a zero-TTL policy for `/_previews/*`, but this does not make lifecycle expiration an exact-time revocation guarantee. Verify origin and viewer behavior in T4/T8/T15 after applying to a disposable provider target.

## Apply and configure the CLI

Production site publishers also need read/write/delete permission on the exact private `_control/site-cache/<site>.json` retry record and `cloudfront:CreateInvalidation` on the configured distribution. This module includes those permissions in its satellite role policy. Review and reapply an older module's IAM policy before using the cache-revalidating CLI; do not broaden satellite storage access to other sites or the registry. Invalidation permission is distribution-scoped in AWS IAM, while the CLI limits its requests to the selected site's changed content paths.

Use a reviewed `terraform plan` before applying. CloudFront distribution changes can take time to propagate. After apply, place the `aws_deployment_config_yaml` output in a local config or a pinned remote config file. Give the admin and satellite workflows their respective role ARNs; each workflow exchanges its GitHub OIDC token for temporary AWS credentials.

The module follows AWS's recommended signed OAC access for private S3 origins and the Terraform AWS provider's CloudFront distribution resources. See [Restrict access to an Amazon S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), [CloudFront distribution Terraform resource](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/cloudfront_distribution.html), and [CloudFront cache behavior TTL guidance](https://docs.aws.amazon.com/AmazonCloudFront/latest/APIReference/API_DefaultCacheBehavior.html).

CloudFront routing, missing-object responses, IAM policy scope, effective browser headers, OIDC assumptions, and live `site publish`, `registry register`, and `registry unregister` smoke tests still require deployment verification in T4, T14, and T15. This source module is not evidence that an AWS account has been configured correctly.

The artifact behavior and the `/_errors/*` behavior attach the enforced HTML resource policy through a CloudFront response headers policy. This covers normal artifact responses and the custom not-found page returned for missing artifact objects. Every ordered cache behavior redirects viewers to HTTPS, so `https:` covers both the artifact's own site path and other HTTPS origins. As specified in the [artifact viewer contract](../../../docs/specification.md#7-artifact-viewer), this intentionally allows same-origin paths and external HTTPS resources; publishing executable HTML remains the trust boundary. The policy preserves inline/eval script support and does not isolate the iframe. CloudFront applies response headers policies to responses for matching cache behaviors; custom error pages use the behavior matching their response-page path. See [Add or remove HTTP headers in CloudFront responses](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/modifying-response-headers.html), [Understand response headers policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html), and [Custom error pages and error caching](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesErrorPages.html).
