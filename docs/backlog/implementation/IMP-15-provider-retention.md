# IMP-15 — Provider-owned preview retention configuration

- Status: Done
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority.
- Depends on: [IMP-12](IMP-12-provider-boundary.md), [IMP-18](IMP-18-cloudflare-preview-adapter.md), and the provider mapping in [T3](../technical-design/T3-provider-retention.md)
- Proves: [T4](../verification/T4-serving-boundary.md), [T8](../verification/T8-stale-reference-cleanup.md), [T15](../verification/T15-provider-delivery.md)

## Outcome

Map the administrator's single preview-retention policy to AWS and Cloudflare lifecycle configuration, including revision files, manifests, catalog inactivity and retained object versions. Do not implement an application expiry clock or per-PR duration.

## Acceptance criteria

- Each provider's lifecycle configuration covers every preview object class and retained version; an inactive site does not accumulate a permanently orphaned catalog.
- A manifest may disappear before its catalog reference; reader hiding and later catalog pruning follow provider availability rather than app time.
- Deployment guidance documents asynchronous removal and cache lag, including the limitation that retention is not exact revocation; live observation belongs to T4/T8/T15.
- The provider-neutral contract remains separate from the adapter-specific configuration and T3 records the mapping.

## Local source evidence

- `infra/aws` expires current preview objects, noncurrent versions, and expired delete markers under `_previews/`; it suspends S3 bucket versioning and aborts incomplete multipart uploads under that prefix after seven days. S3 versioning is bucket-wide, while the cleanup rules are prefix-scoped. Existing noncurrent preview versions are therefore covered without expiring versions outside the preview namespace.
- `infra/cloudflare/retention` defines the Cloudflare `cloudflare_r2_bucket_lifecycle` resource for `_previews/` object expiration from the positive `preview_retention_days` input and seven-day incomplete multipart cleanup. R2's current S3 compatibility table does not support bucket versioning APIs, so R2 has no noncurrent-version case. The module pins `cloudflare/cloudflare` to `5.24.0` and does not manage the bucket. Its README records that this resource owns the complete lifecycle rule set, cannot be imported or destroyed through Terraform, and requires existing rules to be reviewed and merged before apply.
- Terraform 1.9.8 Docker checks passed for both modules: `fmt -check -recursive`, `init -backend=false -input=false`, and `validate`. The Cloudflare offline plan with `preview_retention_days=30` showed one lifecycle-resource create and no other changes; Terraform warned that the lifecycle resource cannot be destroyed. AWS planning was attempted with placeholder credentials and failed at STS `GetCallerIdentity` with `InvalidClientTokenId`; AWS syntax/schema validation passed, but no AWS plan or apply is claimed.
- The AWS deployment guide documents asynchronous S3 lifecycle handling, zero-TTL CloudFront preview behavior, cache/lifecycle lag limits, and the non-revocation guarantee. The provider-neutral contract already states that lifecycle is asynchronous, a catalog can outlive its manifest, missing raw objects must return 404, and retention is not exact-time revocation. No provider account was changed.

## Verification handoff

- Apply each reviewed module configuration to disposable AWS and Cloudflare targets with `preview_retention_days=1`. Seed a preview catalog, manifest, document/resource objects, and (for AWS) at least one noncurrent version. Poll the origin until eligible current/noncurrent objects are gone; record when each class disappears and confirm the inactive catalog eventually expires. Do not treat the configured age as an exact removal deadline. Track these observations in T8/T15.
- Through each deployed delivery URL, poll the catalog, direct manifest/document/resource URLs, response cache headers, and missing-object status during and after origin deletion. Record any edge/browser cache lag; verify the reader hides missing-manifest groups, raw misses remain 404, and later catalog reconciliation prunes the stale reference. T4/T8/T15 own these live serving and cache proofs; local emulators cannot establish provider lifecycle or CDN timing.
- AWS requires credentials in the standard AWS credential chain with permission to apply the module's S3 lifecycle/versioning, bucket, CloudFront, and supporting IAM resources, plus a disposable bucket and distribution ID. Cloudflare requires a scoped API token with `Workers R2 Storage Write`, the account ID, an existing disposable R2 bucket, and a configured delivery custom domain/zone if edge-cache behavior is to be measured. No provider account was changed in this task; the configured lifecycle behavior remains unverified in T4/T8/T15.
