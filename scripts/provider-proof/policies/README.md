# Reviewed provider credential templates

These files are reviewed proof-only templates. They are not deployed policy and contain no credentials. Render unresolved values from the signed, inventoried bindings, review the rendered documents and digests, and obtain the applicable signed transition before an owner executes any account mutation.

## AWS

- `aws-trust-documents.json` contains exact owner SSO trust and exact hosted OIDC audience/subject trust. Subject placeholders must be replaced with full immutable subjects observed from the fixture; wildcard subjects are rejected.
- `aws-inventory-role-policy.json` is read-only. It intentionally reads the existing AWS verification bucket and distribution. It is the only role allowed to read preserved resources. Its `NotAction` deny closes permissions outside its named read set.
- `aws-provisioner-role-policy.json` is the proof provisioner's immutable policy/boundary template. It manages only the named proof resources and new publisher roles; the fixed boundary is required at role creation. It explicitly denies CloudFront create actions. Creation of CloudFront resources that do not yet have ARNs uses the separate, owner-supervised `aws-cloudfront-creation-session.json` exception.
- `aws-test-operator-boundary.json` supplies the maximum proof envelope. Normal phase sessions are narrowed by `aws-session-profiles.json`; the `final-cleanup` profile is the only profile that includes `s3:DeleteObjectVersion`.
- `aws-publisher-boundaries.json` is a narrowing overlay around the reference module allow policies. The admin boundary covers app/registry and the life site used by the A8 owner run. Each satellite boundary is rendered with one exact site ID. Admin does not receive a/b/neighbor satellite write scope.
- Every mutating boundary explicitly denies the preserved bucket, preserved distribution, out-of-scope S3/CloudFront resources, and IAM/STS privilege escalation. The production account's R2 bucket and production zone are absent from all credentials.
- The credential loader binds a fixed source class to each identity. Verification records retain `aws-sso-assumed-role` or `github-actions-oidc`; local SSO-derived evidence must never be presented as hosted/reference-role evidence. Hosted OIDC invocations run the same identity, policy and probe checks before the write invocation.

The CloudFront creation session is a documented exception because the named create operations cannot all be resource-scoped before AWS assigns identifiers. It contains only individually named create actions plus the `TagResource` authorization required by `CreateDistributionWithTags`. Fixed request-tag conditions apply to distribution/function/tag operations where AWS supports them; OAC/cache/response-header creation actions have no such condition key in the current authorization reference. The inventoried existing CloudFront resources and preserved distribution are explicitly denied. This is an owner-supervised session, never a proof-runner credential. After creation, concrete IDs are sealed and reviewed, then exact-resource policies replace creation authority.

`aws-provisioner-role-policy.json` uses IAM action names, not SDK method names. S3 lifecycle authorization uses `s3:GetBucketLifecycleConfiguration` and `s3:PutLifecycleConfiguration`. Terraform provider 6.66.0 refresh reads listed in the plan are included individually. A missing action is a review stop; there is no wildcard service allow.

## Cloudflare

`cloudflare-credential-scopes.json` separates bucket-scoped parent tokens, 15-minute prefix/object children, registry readers, a distinct zone-wide Cache Purge token, and the owner-operated account-wide lifecycle administrator. Parent R2 credentials stay in the private loader. The production account ID is excluded. The file records shared-key, zone-wide purge, and account-wide lifecycle authority as residual scope rather than representing it as path-limited.

The descriptors use Cloudflare's named permission groups and R2 temporary credential operation/path fields. R2 children use explicit actions signed locally, because path and operation restrictions must apply together. Registry reads stay separate from writable paths. See [R2 token permissions](https://developers.cloudflare.com/r2/api/tokens/), [R2 temporary credentials](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/), and [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).
