# AWS CloudFront Terraform caller

This caller uses the sibling `terraform-aws-artifact-pages` module through a relative path. It is a local consumer root; the in-repository module source and route tests are under [`terraform/modules/aws`](../../modules/aws/README.md) and have a separate source/release boundary. It uses one private S3 origin. CloudFront behaviors keep cache handling separate for `/assets/*`, `/_indexes/*`, `/_artifacts/*`, and `/_previews/*`; unmatched paths use the app shell. There is no WAF configured.

The CloudFront Function rewrites unmatched paths to `/index.html`. `/_control/*` has no content behavior, so a request for that path falls through to the app shell and does not read the private control object. Content and asset behaviors remain explicit so missing objects return 404 instead of the app shell.

The committed `terraform.tfvars.example` contains placeholders. Copy it to the ignored `terraform.tfvars`, then replace the existing GitHub OIDC provider ARN and admin repository subject with values for the target AWS account. `bucket_name` is optional; if omitted, the module derives `artifact-pages-<OIDC account ID>-<AWS region>` from the supplied OIDC provider ARN and region. Availability is not guaranteed, and a collision fails without a random fallback. The module does not query AWS to discover or verify the provider account; its existing contract assumes the OIDC provider ARN and AWS provider target the same account. The module does not create an OIDC provider. `web_acl_arn` is intentionally omitted, so the optional WAF remains unset.

From the apprepo root:

```sh
mkdir -p .local/terraform/aws
cp -n terraform/deployments/aws/terraform.tfvars.example terraform/deployments/aws/terraform.tfvars
# Edit terraform/deployments/aws/terraform.tfvars with the target AWS account values.
terraform -chdir=terraform/deployments/aws init
terraform -chdir=terraform/deployments/aws plan -var-file=terraform.tfvars
```

The local backend keeps state in the ignored `.local/` directory. `preview_retention_days` is enforced only by Terraform's S3 lifecycle configuration and is omitted from the generated CLI configuration; S3 expiration is asynchronous. The generated CLI configuration includes the effective bucket name and the account ID from the configured OIDC provider ARN. Without `aliases` and an ACM certificate, the distribution uses its default CloudFront hostname. To use a custom hostname, provide an ACM certificate in `us-east-1` and manage DNS to point to the distribution; Cloudflare, if retained as the DNS provider, only needs DNS records and does not need to proxy viewer traffic.
