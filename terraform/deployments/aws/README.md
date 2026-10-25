# AWS verification deployment

This caller uses the root AWS module directly and is reached at its default CloudFront hostname, exposed as the `distribution_domain_name` output. It creates no ACM certificate or DNS records. For a custom domain, see the module's [caller-managed custom-domain guidance](../../modules/aws/README.md#custom-domain-with-route-53) and [`examples/route53-consumer`](../../modules/aws/examples/route53-consumer/README.md).

The default AWS account is `231136241959`. The AWS provider has `allowed_account_ids` set to that account, and the root module checks that its identity matches the account in the GitHub OIDC provider ARN. Set `AWS_PROFILE=artifact-pages-verify` after `aws sso login --profile artifact-pages-verify`; the profile uses short-lived IAM Identity Center credentials. Do not export AWS access keys from `tfstate.env`. State is kept in the private S3 bucket `artifact-pages-verify-tfstate-231136241959` in the same account (`us-east-1`), under key `aws-verify/terraform.tfstate`, with S3 native locking. The backend uses the same `artifact-pages-verify` SSO profile and has `allowed_account_ids` set to `231136241959`. Nothing here uses production credentials, the production `artifact-pages-tfstate` bucket or files under `~/.config/artifact-pages/`; keep this deployment's local files under `~/.config/artifact-pages-verify/` (mode 700).

## Local validation

No `terraform.tfvars` edit is needed for local validation. The verification test mocks AWS only and checks the default CloudFront hostname, hosted zone output, and the single `aws-verify` satellite.

Run the local validation from this directory with the repository's pinned Terraform version:

```sh
mise exec terraform@1.16.4 -- terraform init -backend=false -input=false
mise exec terraform@1.16.4 -- terraform validate
mise exec terraform@1.16.4 -- terraform test -no-color
```

The broader AWS module account-mismatch and deployment-contract checks run through `terraform/modules/aws/scripts/validate.sh`. These tests do not contact AWS and do not prove CloudFront deployment, TLS, deployed routes, headers, or browser behavior.

## GitHub OIDC subjects

Both operator repositories currently use GitHub's default subject template with immutable subjects (`use_default = true`, `use_immutable_subject = true`). A read-only lookup returned `repo:artifact-pages@338198830/admin@1402509181` for the `artifact-pages/admin` `sub_claim_prefix` and `repo:artifact-pages@338198830/docs@1402509222` for `artifact-pages/docs`. Because the verification workflows use the `aws-verify` environment under that default template, their exact subjects append `:environment:aws-verify` to those prefixes. The defaults and `terraform.tfvars.example` use those exact values.

Recheck a repository's prefix with `gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq '.sub_claim_prefix'`. If its repository OIDC setting or the job's environment/ref changes, update the exact subject input and recreate any saved plan before review. A custom subject template can replace the default suffix, so inspect its emitted `sub` instead of assuming the environment/ref form. The general module also accepts a legacy name-based subject such as `repo:artifact-pages/admin:environment:aws-verify` when that exact string is explicitly supplied. It uses `StringEquals`; it does not match a prefix or wildcard. See the [module's OIDC subject guidance](../../modules/aws/README.md#github-oidc-subject-claims). A custom `job_workflow_ref` condition remains an optional caller choice.

## State bucket

The bucket was created once, outside Terraform, so this root can store its own state. Recreate it only when it is missing, using the `artifact-pages-verify` SSO profile:

```sh
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  aws s3api create-bucket --bucket artifact-pages-verify-tfstate-231136241959 --region us-east-1
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  aws s3api put-public-access-block --bucket artifact-pages-verify-tfstate-231136241959 \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  aws s3api put-bucket-ownership-controls --bucket artifact-pages-verify-tfstate-231136241959 \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  aws s3api put-bucket-versioning --bucket artifact-pages-verify-tfstate-231136241959 \
  --versioning-configuration Status=Enabled
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  aws s3api put-bucket-encryption --bucket artifact-pages-verify-tfstate-231136241959 \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"},"BucketKeyEnabled":true}]}'
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  aws s3api put-bucket-policy --bucket artifact-pages-verify-tfstate-231136241959 --policy file://deny-insecure-transport.json
```

Create `deny-insecure-transport.json` with this content:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::artifact-pages-verify-tfstate-231136241959",
        "arn:aws:s3:::artifact-pages-verify-tfstate-231136241959/*"
      ],
      "Condition": {
        "Bool": {
          "aws:SecureTransport": "false"
        }
      }
    }
  ]
}
```

Versioning keeps earlier state versions; never delete the bucket while the deployment exists.

## Real saved plan

Log in to the AWS SSO profile and initialize the configured remote backend. The backend uses the same SSO profile; do not source any `tfstate.env`. The untracked `terraform.tfvars` file is optional and can be copied from `terraform.tfvars.example` for optional WAF or viewer settings. The command below keeps `-var-file=terraform.tfvars`; create that file from the example when using this command. Save plans and logs outside Git with owner-only permissions.

```sh
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE aws sso login --profile artifact-pages-verify
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  mise exec terraform@1.16.4 -- terraform init -input=false
install -d -m 700 "$HOME/.config/artifact-pages-verify/aws-verify"
umask 077
PLAN="$HOME/.config/artifact-pages-verify/aws-verify/aws-verify.tfplan"
PLAN_LOG="$HOME/.config/artifact-pages-verify/aws-verify/aws-verify.plan.log"
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  mise exec terraform@1.16.4 -- terraform plan -input=false \
  -var-file=terraform.tfvars -out="$PLAN" >"$PLAN_LOG" 2>&1
chmod 600 "$PLAN" "$PLAN_LOG"
```

The saved plan is the review artifact; do not apply it before the owner approves that exact plan. Recreate and re-review it if the source, credentials, state, or inputs change. Terraform plans and their logs can contain sensitive values, so keep both files outside Git with mode `0600`.

Before asking for approval, check that:

- The default AWS identity resolves to `231136241959`, and the configured GitHub OIDC provider ARN names that same account.
- `aws-verify` is the only satellite site added for this disposable deployment. Its role trusts `repo:artifact-pages@338198830/docs@1402509222:environment:aws-verify`; the admin role trusts `repo:artifact-pages@338198830/admin@1402509181:environment:aws-verify`. These subject strings alone do not prove isolation. Before any OIDC proof, create the dedicated `aws-verify` GitHub environments, restrict deployments to `main`, and add dedicated verification workflows that use those environments. Do not use either repository's `production` environment for this AWS role.
- The plan contains no ACM, Route 53, or Cloudflare resources; the distribution has no aliases and uses the default CloudFront certificate; and there are no unreviewed replacements or deletions.
- Review the complete resource list and include a monthly cost projection with low, expected, and high usage assumptions. Estimate CloudFront data transfer and requests, S3 storage, requests and lifecycle effects, and AWS WAF charges if a WAF is enabled. WAF is omitted by default. Use the current AWS Pricing Calculator for the selected regions and actual plan. The account's `$5` AWS Budget sends alerts; it does not cap or stop charges.
- The selected S3 bucket name is globally available and the distribution uses the intended price class. Note that S3 lifecycle expiration is asynchronous, so `preview_retention_days = 1` is not an exact one-day deletion guarantee.

After a separately approved apply, T15 must still verify CloudFront `Deployed`, TLS on the default CloudFront hostname, direct CloudFront and private-S3 boundaries, application/content routes and 404s, the trusted-content headers (including `X-Content-Type-Options: nosniff`), `/_control` denial and origin privacy, satellite isolation, origin-respecting freshness without invalidation, fresh-bucket bootstrap, and `LICENSE`/notice delivery. Those are live acceptance checks; local validation does not establish them.
