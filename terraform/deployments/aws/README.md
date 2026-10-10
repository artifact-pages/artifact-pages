# AWS verification deployment

This caller composes [`terraform/modules/aws/modules/cloudflare-dns-acm`](../../modules/aws/modules/cloudflare-dns-acm/README.md) for the disposable `aws.artifact-pages.stream` verification hostname. It creates the AWS private S3 origin and CloudFront distribution, obtains the viewer certificate through ACM in `us-east-1`, and manages only the hostname's Cloudflare DNS-only CNAME plus ACM validation CNAMEs in the existing `artifact-pages.stream` zone. It creates no Route 53 resources and does not proxy AWS delivery through Cloudflare. The reusable AWS module remains usable on its own with the default CloudFront hostname or caller-managed DNS and certificate.

The default AWS account is `231136241959`. Both AWS provider configurations have `allowed_account_ids` set to that account, and the composition separately checks that both provider identities match the account in the existing GitHub OIDC provider ARN. Set `AWS_PROFILE=artifact-pages-verify` after `aws sso login --profile artifact-pages-verify`; the profile uses short-lived IAM Identity Center credentials. Do not export AWS access keys from `tfstate.env`. The remote S3-compatible backend is Cloudflare R2, with state key `aws-verify`. Backend access uses the separate `artifact-pages-tfstate` profile and `~/.config/artifact-pages/tfstate-aws-credentials` credentials file. The backend endpoint and credential-file path are already configured in `versions.tf`; provision the local credentials file through the operator's approved setup, and do not commit or print its values. Keep backend credentials separate from the AWS provider's SSO profile.

## Local validation

The committed `terraform.tfvars.example` has a placeholder Cloudflare zone ID. Copy it to the ignored `terraform.tfvars` and replace that one value with the existing `artifact-pages.stream` zone ID. Keep the file outside Git and do not put Cloudflare token values in Terraform variables.

The real AWS provider reads the SSO profile from `AWS_PROFILE`. The Cloudflare provider reads `CLOUDFLARE_API_TOKEN` from the environment. That token must have `Zone > DNS > Edit` scoped only to `artifact-pages.stream`; Cloudflare DNS Edit includes the read/list access needed to refresh the managed records. The composition receives the existing zone ID directly, so it does not need Zone Read. No Cloudflare token is stored in this repository.

Run the local validation from this directory with the repository's pinned Terraform version:

```sh
mise exec terraform@1.16.4 -- terraform init -backend=false -input=false
mise exec terraform@1.16.4 -- terraform validate
mise exec terraform@1.16.4 -- terraform test -no-color
```

`tests/verification.tftest.hcl` mocks AWS and Cloudflare while planning this exact caller. It checks the selected hostname, ACM output, both DNS record outputs and that `aws-verify` is the only satellite role. CI runs this caller test. The broader AWS module account-mismatch and deployment-contract checks run through `terraform/modules/aws/scripts/validate.sh`. These tests do not contact AWS or Cloudflare and do not prove certificate issuance, DNS propagation, deployed routes, headers or browser behavior.

## Real saved plan

After the Cloudflare token is available, log in to the AWS SSO profile and initialize the configured remote backend. The backend must continue using its named R2 profile; do not source `tfstate.env`. Save plans and logs outside Git with owner-only permissions. For example, after copying the example variable file and replacing the zone ID:

```sh
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE aws sso login --profile artifact-pages-verify
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-tfstate \
  mise exec terraform@1.16.4 -- terraform init -input=false
install -d -m 700 "$HOME/.config/artifact-pages/aws-verify"
umask 077
PLAN="$HOME/.config/artifact-pages/aws-verify/aws-verify.tfplan"
PLAN_LOG="$HOME/.config/artifact-pages/aws-verify/aws-verify.plan.log"
env -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
  -u AWS_SECURITY_TOKEN -u AWS_WEB_IDENTITY_TOKEN_FILE -u AWS_ROLE_ARN \
  -u AWS_SHARED_CREDENTIALS_FILE AWS_PROFILE=artifact-pages-verify \
  mise exec terraform@1.16.4 -- terraform plan -input=false \
  -var-file=terraform.tfvars -out="$PLAN" >"$PLAN_LOG" 2>&1
chmod 600 "$PLAN" "$PLAN_LOG"
```

The saved plan is the review artifact; do not apply it before the owner approves that exact plan. Recreate and re-review it if the source, credentials, state, or inputs change. Terraform plans and their logs can contain sensitive values, so keep both files outside Git with mode `0600`.

Before asking for approval, check that:

- The plan's default and `us-east-1` AWS identities both resolve to `231136241959`, and the configured GitHub OIDC provider ARN names that same account.
- `aws-verify` is the only satellite site added for this disposable deployment. Its role trusts `repo:artifact-pages/docs:environment:aws-verify`; the admin role trusts `repo:artifact-pages/admin:environment:aws-verify`. These subject strings alone do not prove isolation. Before any OIDC proof, create the dedicated `aws-verify` GitHub environments, restrict deployments to `main`, and add dedicated verification workflows that use those environments. Do not use either repository's `production` environment for this AWS role.
- The ACM certificate covers exactly `aws.artifact-pages.stream`, is in `us-east-1`, and completes DNS validation before CloudFront attaches it. All validation records are CNAMEs in the selected zone, DNS-only, with automatic TTL.
- Exactly one DNS-only CNAME for `aws.artifact-pages.stream` points to the planned CloudFront distribution. The plan contains no Route 53 resources, apex record, unrelated DNS records, Cloudflare proxying, or unreviewed replacements and deletions.
- Review the complete resource list and include a monthly cost projection with low, expected and high usage assumptions. Estimate CloudFront data transfer and requests, S3 storage, requests and lifecycle effects, and AWS WAF charges if a WAF is enabled. WAF is omitted by default. Use the current AWS Pricing Calculator for the selected regions and actual plan. The account's `$5` AWS Budget sends alerts; it does not cap or stop charges.
- The selected S3 bucket name is globally available and the distribution uses the intended price class. Note that S3 lifecycle expiration is asynchronous, so `preview_retention_days = 1` is not an exact one-day deletion guarantee.

After a separately approved apply, T15 must still verify ACM `ISSUED`, CloudFront `Deployed`, DNS resolution and TLS, direct CloudFront and private-S3 boundaries, application/content routes and 404s, the trusted-content headers (including `X-Content-Type-Options: nosniff`), `/_control` denial and origin privacy, satellite isolation, invalidation, fresh-bucket bootstrap, and `LICENSE`/notice delivery. Those are live acceptance checks; local validation does not establish them.
