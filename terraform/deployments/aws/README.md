# AWS CloudFront Terraform caller

This caller uses the in-repository [`terraform/modules/aws`](../../modules/aws/README.md) module through a relative path (the module is the source of truth for the generated `terraform-aws-artifact-pages` package, TD15). It is a local consumer root and holds the `provider "aws"` configuration, which the module does not declare. It uses one private S3 origin. CloudFront behaviors keep cache handling separate for `/assets/*`, `/_indexes/*`, `/_artifacts/*`, and `/_previews/*`; unmatched paths use the app shell. There is no WAF configured.

The CloudFront viewer-request function rewrites unmatched paths to `/index.html`. `/_control/*` has no content behavior, so a request for that path falls through to the app shell and does not read the private control object. Content and asset behaviors remain explicit so missing objects return 404 instead of the app shell.

The committed `terraform.tfvars.example` contains placeholders. Copy it to the ignored `terraform.tfvars`, then replace the existing GitHub OIDC provider ARN and admin repository subject with values for the target AWS account. `bucket_name` is optional; if omitted, the module derives `artifact-pages-<OIDC account ID>-<AWS region>` from the supplied OIDC provider ARN and region. Availability is not guaranteed, and a collision fails without a random fallback. The module reads the provider account with `aws_caller_identity` and stops the plan when it differs from the account in the OIDC provider ARN. The module does not create an OIDC provider. `web_acl_arn` and `waf_custom_rules` are omitted by default, so no WAF is attached; see the module's [viewer policy](../../modules/aws/docs/waf.md).

The backend stores state in the private `artifact-pages-tfstate` R2 bucket under key `aws-verify`. It reads the `[artifact-pages-tfstate]` profile from `~/.config/artifact-pages/tfstate-aws-credentials`, generated outside Git from `~/.config/artifact-pages/tfstate.env` using the safe procedure in workspace `ops/OPS-004`.

Do not source the R2 `tfstate.env` for this AWS provider: its `AWS_*` variables would be selected as AWS provider credentials. The backend profile and AWS provider credentials are separate; use actual credentials for the target AWS account if an AWS deployment is introduced. This root currently has no AWS state or deployment, so initialize the backend only and do not plan or apply AWS resources.

Initialize from this directory:

```sh
cd terraform/deployments/aws
mise exec terraform@1.16.4 -- terraform init
```

`preview_retention_days` is enforced only by Terraform's S3 lifecycle configuration and is omitted from the generated CLI configuration; S3 expiration is asynchronous. The generated CLI configuration includes the effective bucket name and the account ID from the configured OIDC provider ARN. Without `aliases` and an ACM certificate, the distribution uses its default CloudFront hostname. To use a custom hostname, provide an ACM certificate in `us-east-1` and manage DNS to point to the distribution; Cloudflare, if retained as the DNS provider, only needs DNS records and does not need to proxy viewer traffic.
