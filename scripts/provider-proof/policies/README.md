# Provider proof policy documents

These are reviewable templates for the one-off provider verification. They contain no credentials and are not deployed policies by themselves. Approval is chat-based: the owner reviews and approves each phase separately. Before each phase, show the concrete commands, rendered policies, credential identities, targets, evidence locations, and caps. Creating a missing role or token is a separate administrative prerequisite and needs its own approval.

## Policy file purposes

### AWS

- `aws-trust-documents.json` describes the exact owner SSO role allowed to assume the operator roles and the GitHub OIDC trust conditions. OIDC trust requires audience `sts.amazonaws.com` and an exact repository/environment subject; replace each subject placeholder with the full subject observed for that fixture. Do not use wildcard subjects.
- `aws-inventory-role-policy.json` is the read-only A4 inventory policy. It limits reads to the preserved AWS deployment, exact inventoried verification roles and policies, the proposed proof-bucket availability check, and the exact Terraform state object.
- `aws-provisioner-role-policy.json` is the owner-supervised Terraform provisioning policy for the new verification resources and publisher roles. It is not an inventory policy and must be reviewed against the concrete create plan.
- `aws-cloudfront-creation-session.json` is a separately supervised exception for CloudFront create operations that cannot be scoped to resource ARNs before AWS assigns IDs. Use it only for the reviewed create plan; after inventory, use policies scoped to the resulting resource ARNs.
- `aws-test-operator-boundary.json` is the maximum permissions boundary for proof operator sessions. `aws-session-profiles.json` narrows individual phase sessions; only its final-cleanup profile includes `s3:DeleteObjectVersion`.
- `aws-publisher-boundaries.json` narrows the reference module's publisher permissions. The admin boundary covers app and registry operations; each satellite boundary is rendered for one exact site ID.

### Cloudflare

- `cloudflare-credential-scopes.json` describes separate verification-account credentials for R2 content, R2 configuration, backend-state reads, short-lived site writers, registry reads, zone cache purge, and the lifecycle administrator. It records residual scope such as zone-wide purge and account-wide lifecycle authority. No production credential is included.

The complete read-only Cloudflare permission set for refreshing every deployed ruleset is not established here. Confirm the read-only permission groups before a full Terraform refresh; do not substitute edit permissions or guess permission IDs.

## A4 inventory amendments

The A4 AWS inventory target is account `231136241959`. The preserved bucket is `artifact-pages-231136241959-us-east-1`; the preserved CloudFront distribution is `ECFTIR5GVPQDF`. The proposed proof bucket is `ap-proof-231136241959-20261018`. Its exact `s3:ListBucket` permission is for the planned `head-bucket` availability check. AWS maps that check to `s3:ListBucket`, which can also reveal key names if the bucket is occupied; the planned invocation must not list objects, and the inventory role has no object-content read or write access to that bucket. If it is occupied or the result is inconclusive, stop and never adopt it.

The inventory policy applies these deltas:

1. It binds the preserved bucket and distribution to the exact IDs above and removes the nonexistent proof-distribution binding.
2. It uses `s3:GetLifecycleConfiguration` and `s3:GetReplicationConfiguration` for the inventory reads.
3. It permits `s3:GetObject` only on `arn:aws:s3:::artifact-pages-verify-tfstate-231136241959/aws-verify/terraform.tfstate`. It permits `s3:ListBucket` on the state bucket only for the exact state key prefix or Terraform's `env:/` workspace-enumeration prefix during backend initialization. It grants no state writes or `.tflock` access.
4. It scopes IAM role reads to exact inventoried role ARNs and IAM policy reads to exact inventoried policy ARNs. This includes any attached AWS-managed policy ARN discovered in the first read batch; it does not enumerate account roles or policies.
5. It adds CloudFront reads for the preserved distribution's exact Origin Access Control, cache policy, response headers policy, and function references, with `DenyAllOtherDistributions` exceptions for those exact ARNs.
6. Its unconditional `DenyOutsideEnumeratedInventoryReads` `NotAction` list is generated from the union of all `Allow` actions. The list has no wildcard actions; scoped `Allow` statements still determine which resources can be read.

The AWS provider is locked to 6.66.0 for the AWS root. The full `terraform plan -refresh-only` refreshes the declared S3 bucket and bucket-configuration resources, S3 object and bucket-policy resources, CloudFront distribution/OAC/function/cache-policy/response-headers-policy resources, IAM roles and inline policies, and optional module-managed WAF resources. The inventory policy includes the provider's read calls for those resource types: S3 bucket ACL, notification, object-lock configuration, website, logging and the other listed bucket settings; IAM role tags, instance profiles, inline/attached policies and policy tags; CloudFront tags for each exact distribution and associated resource; and WAFv2 web ACL/IP set reads for exact optional resource ARNs. These reads remain scoped to the preserved bucket and distribution, the exact associated-resource ARNs, exact role/policy ARNs, and exact WAF ARNs. The WAF ARN placeholders apply only if the first read batch confirms module-managed WAF resources in the state.

If refresh returns `AccessDenied`, record the denied action and relevant resource ARN, stop the refresh, and propose a policy amendment in chat for owner review. Do not widen the policy silently or retry with broader access.

The policy contains placeholders until IDs are read. Replace them with values from the first inventory read batch, then review the rendered policy and concrete second-batch command list in chat before running those reads. Repeat each CloudFront placeholder entry for every distinct associated resource ARN found. Do not use the policy while a placeholder remains:

- `<OAC_ID from get-distribution-config>` — Origin Access Control ID.
- `<CACHE_POLICY_ARN from get-distribution-config>` — exact cache policy ARN, including its owning account where applicable.
- `<RESPONSE_HEADERS_POLICY_ARN from get-distribution-config>` — exact response headers policy ARN.
- `<FUNCTION_ARN from get-distribution-config>` — exact CloudFront function ARN.
- `<INVENTORY_ROLE_ARN from first inventory read>` — the active inventory role ARN.
- `<EXISTING_VERIFICATION_ROLE_ARN from first inventory read>` — repeat this entry for every exact existing verification role ARN.
- `<EXISTING_VERIFICATION_POLICY_ARN from first inventory read>` — repeat this entry for every exact existing verification policy ARN.
- `<ATTACHED_AWS_MANAGED_POLICY_ARN from first inventory read>` — repeat this entry for each attached AWS-managed policy discovered in the first read batch, using its exact `arn:aws:iam::aws:policy/...` ARN for subsequent policy reads.
- `<WAF_WEB_ACL_ARN from first inventory read>`, `<WAF_IP_SET_IPV4_ARN from first inventory read>`, and `<WAF_IP_SET_IPV6_ARN from first inventory read>` — exact ARNs for module-managed WAF resources if those optional resources are present in the state.

The action-name corrections above follow the decision report and were not validated against AWS during this repository change. A4 itself makes no remote-state writes, locking, migration, repair, or apply. Production credentials and production requests are out of scope. The Cloudflare verification account is `21a0acb78621cc00cfa655a276d77b74` and its zone is `artifact-pages.stream`; the production account `9ac354c8aa31d424224d8c4f3aa8ba2a`, bucket `artifact-pages`, and zone `artifact-pages.dev` are excluded.

## Approval, evidence, and credential handling

For A4, the owner sees the rendered policies, credential identities, complete expanded command list, evidence locations, expected targets, and caps before saying OK. Repeat phase-specific review before each later phase. Keep raw provider responses in a private evidence directory. Use `umask 077` and create a new evidence directory with mode `0700`. Keep secrets out of command arguments, stdout, stderr, logs, and repository files; do not log authorization headers or credential material. Save each command's output and error separately, with UTC timestamps, exit status, and request IDs where available.

## Preservation, lifecycle, and cleanup rules

- A4 and final comparisons preserve the original AWS objects, versions, state, distribution configuration, Cloudflare registry membership, and unrelated provider configuration. Compare raw object bytes/hashes, versions, metadata, tags, and configuration; record expected operational changes separately. Any unrelated change stops the run for review.
- The temporary Cloudflare lifecycle rule is `proof-life-20261018-expire`, enabled, scoped to `_previews/proof-life-20261018/`, expiring objects at 86,400 seconds and aborting incomplete multipart uploads at 604,800 seconds. Compare complete rule sets sorted by ID. Adding the temporary rule must leave every baseline rule unchanged and include exactly one matching temporary rule. Restoration removes only that rule and must make the complete policy equal the baseline.
- After A7, remove only the temporary `proof-a-20261018`, `proof-b-20261018`, and `proof-neighbor-20261018` site data. Preserve `proof-life-20261018` and do not destroy the AWS proof stack. Keep the life prefix read-only during observation. After observation is recorded as complete or censored, A9 is recorded as completed or not-run, and the Cloudflare lifecycle policy is restored exactly, review a fresh destroy plan. Only then clean up the life site and destroy the enumerated proof resources under the separately approved phase.
- Never mutate the preserved AWS bucket or distribution, unrelated resources, or production account resources.

The combined run limits are 14 operator hours, $20, five elapsed days, 1 GiB stored per provider, 5 GiB CDN transfer per provider, 50,000 storage operations per provider, 5,000 viewer requests per provider, and 200 CloudFront invalidation paths. Keep a plain usage ledger with conservative allowances for retries. Stop before exceeding a cap; if A4 inventory cannot fit its 30-minute allowance, request an owner amendment before continuing.
