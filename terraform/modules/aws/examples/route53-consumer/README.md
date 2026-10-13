# Route 53 custom-domain consumer example

This caller creates a DNS-validated ACM viewer certificate in `us-east-1`, the AWS reference deployment (private S3 origin, CloudFront and IAM roles), and Route 53 Alias A and AAAA records for the custom hostname. It creates the certificate and DNS-validation records first, then the CloudFront distribution with the alias, and then the Route 53 aliases. The public Route 53 hosted zone must already exist; this example does not create it.

The default `aws` provider and its `us_east_1` alias must target the account in `github_oidc_provider_arn`. The example uses placeholder values in `terraform.tfvars.example`; replace them with values for the existing hosted zone, hostname, AWS account, and GitHub OIDC subjects before using the configuration.

Run from this directory:

```sh
terraform init -backend=false -input=false
terraform validate
```
