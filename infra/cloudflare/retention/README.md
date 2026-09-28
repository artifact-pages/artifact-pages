# Cloudflare R2 preview retention

This module manages lifecycle rules on an **existing** R2 bucket. It does not create, modify, or delete the bucket. It configures expiration for objects under `_previews/` after `preview_retention_days`, and aborts incomplete multipart uploads under that prefix after seven days.

## Lifecycle ownership

The `cloudflare_r2_bucket_lifecycle` resource owns the bucket's **complete lifecycle rule set**. Its `rules` value is the full desired configuration, not an additive rule fragment. Before using this module on a bucket with existing lifecycle rules, inspect those rules and merge every rule that must remain into this resource configuration. Applying an incomplete list can replace rules managed elsewhere.

The Cloudflare provider currently does not support importing this resource. This module therefore cannot safely adopt an existing lifecycle configuration through Terraform import; review and reconcile the complete rule set before first use.

The provider also warns that this resource cannot be destroyed through Terraform. Removing the resource from Terraform does not remove the lifecycle rules from R2. To remove a rule, use the Cloudflare dashboard, Wrangler's `r2 bucket lifecycle remove`, or the supported lifecycle API and identify the exact rule ID. Do not rely on `terraform destroy` to undo an applied lifecycle policy.

## Inputs and provider setup

Provide `account_id`, the existing `bucket_name`, and one positive whole-number `preview_retention_days` value. The module pins `cloudflare/cloudflare` to version `5.24.0`. Configure provider authentication in the calling root module or with `CLOUDFLARE_API_TOKEN`; the token needs the `Workers R2 Storage Write` permission for lifecycle changes.

Example declaration:

```hcl
module "preview_retention" {
  source = "./infra/cloudflare/retention"

  account_id             = "00000000000000000000000000000000"
  bucket_name            = "existing-artifact-pages-bucket"
  preview_retention_days = 30
}
```

Review the complete lifecycle plan and any rules already present on the bucket before applying a caller configuration. Terraform 1.9.8 `fmt -check -recursive`, initialization without a backend, validation, and an offline placeholder-input plan have passed. The plan contains one lifecycle-resource create. This module has not been applied to a Cloudflare account, so live deletion timing and delivery-cache behavior remain unverified.

## R2 limits and deletion timing

R2 does not implement the S3 `GetBucketVersioning` or `PutBucketVersioning` APIs. This module cannot configure S3 bucket-versioning behavior or expiration of noncurrent versions through those APIs.

Lifecycle deletion is asynchronous. Cloudflare says objects are typically removed within 24 hours after expiration, and existing objects or large buckets may take longer. Retention is therefore a provider-managed policy, not an exact deletion deadline or immediate revocation guarantee.

References: [Cloudflare R2 object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/), [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/), and [Cloudflare Terraform resource documentation](https://registry.terraform.io/providers/cloudflare/cloudflare/latest/docs/resources/r2_bucket_lifecycle).
