# AWS deployment

This guide creates a private S3 bucket behind a CloudFront distribution with the Artifact Pages Terraform module, then deploys the application and registered sites to it from GitHub Actions through OIDC roles. For Cloudflare, see the [Cloudflare deployment guide](cloudflare-deployment.md).

Parts of this flow were exercised on a disposable verification deployment (see the [T15 evidence](../backlog/verification/T15-provider-delivery.md)). Four behaviours are still open; they are listed under [Limitations](#limitations) and this guide does not claim them.

## Prerequisites

- **A GitHub Actions OIDC identity provider in the AWS account.** The module takes its ARN as `github_oidc_provider_arn` and does not create it. The account ID in the ARN must match the account of the AWS provider you apply with; planning stops on a mismatch.
- **An identity that can apply the module.** The minimum IAM permissions needed to apply it have not been established. The verification deployment was applied with broad administrator access, and this guide provides no least-privilege policy. The apply touches S3, CloudFront and IAM (it creates roles and inline policies and reads the OIDC provider), STS `GetCallerIdentity` for the account guard, and WAFv2 only when `waf_custom_rules` is set.
- **Terraform.** The module requires Terraform 1.5.0 or later and the `hashicorp/aws` provider `~> 6.0` (`terraform/modules/aws/versions.tf`).
- **CLI 0.4.0 or later.** The module grants site roles access only to the per-site control prefix `_control/sites/<site>/`, which older CLIs do not use. The module version and the CLI version are otherwise independent.
- **Optional, for a custom domain:** a hostname you control and an ACM certificate in `us-east-1`. The module never creates DNS records.

## 1. Prepare AWS

Call the module from your own Terraform configuration. Lead with the Terraform Registry:

```hcl
module "artifact_pages" {
  source  = "artifact-pages/artifact-pages/aws"
  version = "0.1.1"

  aws_region             = "us-east-1"
  preview_retention_days = 14

  github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"

  admin_github_subjects = [
    "repo:example/platform-admin:environment:artifact-pages-production",
  ]

  satellite_github_subjects = {
    sre = ["repo:example/sre-docs:environment:artifact-pages-production"]
  }
}
```

The alternative is the Git source of the generated package. Use it without a `version` argument:

```hcl
source = "git::https://github.com/artifact-pages/terraform-aws-artifact-pages.git?ref=v0.1.1"
```

The caller owns the AWS provider configuration. Set its region to the same value as `aws_region`.

### Inputs you set

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `aws_region` | yes | none | Region for the S3 bucket and IAM roles. |
| `preview_retention_days` | yes | none | Whole number from 1 to 36500; lifetime of objects under `_previews/`. |
| `github_oidc_provider_arn` | yes | none | ARN of the existing provider, with a 12-digit account ID. |
| `admin_github_subjects` | yes | none | One or more exact `sub` claims allowed to assume the admin role. |
| `satellite_github_subjects` | no | `{}` | Map from site ID to exact `sub` claims; one role per key. |
| `name_prefix` | no | `artifact-pages` | Prefix of the IAM role names. If you change it, set `aws.namePrefix` to the same value in the CLI config. |
| `bucket_name` | no | `artifact-pages-<account>-<region>` | S3 names are global; availability is not guaranteed. |
| `aliases` | no | `[]` | Custom hostnames; require `acm_certificate_arn`. |
| `acm_certificate_arn` | no | `null` | Certificate in `us-east-1`. |
| `price_class` | no | `PriceClass_100` | CloudFront edge location class. |
| `viewer_protocol_policy` | no | `redirect-to-https` | Or `https-only`. |
| `web_acl_arn`, `waf_custom_rules` | no | `null` | Optional WAF; set at most one. See the [viewer policy](../../terraform/modules/aws/docs/waf.md). |
| `tags` | no | `{}` | Tags for supported resources. |
| `github_oidc_issuer_url` | no | `https://token.actions.githubusercontent.com` | Leave it unless your provider differs. |

The module README is the full reference: [AWS module README](../../terraform/modules/aws/README.md).

### Two kinds of IAM role

The module creates two kinds of role, and no others:

- **The admin role**, `<name_prefix>-admin-publisher`. It runs registry sync, application deploy, unregistering a site (removal of its content by omission from the registry) and writes every `_control/*` record. It can also create CloudFront invalidations. Use it from the admin repository with `registry-action` and `app-deploy-action`. There is no separate app-deploy role.
- **One satellite role per site**, `<name_prefix>-<site-id>-publisher` (a hashed name is used if that exceeds 64 characters). It runs site sync, preview publish and preview remove for that one site only: its own `_indexes/<site>/`, `_artifacts/<site>/`, `_previews/<site>/` and `_control/sites/<site>/`. It can also read `_indexes/sites.json` and `_control/versions/app.json` and create CloudFront invalidations. There is no separate preview role.

Each role trusts the GitHub OIDC provider with `StringEquals` on `aud` (`sts.amazonaws.com`) and on `sub`. The module adds no wildcards and does not infer the job's environment or ref, so every allowed subject is listed exactly.

### OIDC subjects

For a job that declares an environment, the default subject is `repo:OWNER/REPO:environment:ENV`. A repository can instead use the immutable form, `repo:OWNER@OWNER_ID/REPO@REPO_ID:environment:ENV`. Without an environment the context part is a ref, such as `:ref:refs/heads/main`. Read a repository's prefix with:

```sh
gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq '.sub_claim_prefix'
```

Append the job context to that prefix and list the result. On the verification deployment the organization used the immutable form, and a job that did not declare the environment (subject ending in `:ref:refs/heads/main`) was rejected with `Not authorized to perform sts:AssumeRoleWithWebIdentity`. A repository with a custom subject template can emit a different claim, so inspect the actual `sub` from a controlled workflow.

Create the GitHub environment, with a deployment-branch policy, before the first workflow run. A workflow that names a missing environment makes GitHub create it automatically, without branch restrictions.

### Delivery hostname and custom domain

With no `aliases`, CloudFront serves the app on its default hostname, such as `https://d111111abcdef8.cloudfront.net`. That needs no certificate and no DNS, and it is the setup the verification deployment ran on. Read the hostname from the `distribution_domain_name` output.

For a custom domain with Route 53, follow the [Route 53 consumer example](../../terraform/modules/aws/examples/route53-consumer). It creates the DNS-validated ACM certificate in `us-east-1`, the module, and the Route 53 alias A and AAAA records from `distribution_hosted_zone_id`. The certificate must be issued before the distribution uses the alias.

With another DNS provider, create the certificate's validation records there and wait for issuance, set `aliases` and `acm_certificate_arn`, then point a CNAME at `distribution_domain_name`. Do not proxy it through another CDN; with Cloudflare DNS, use a DNS-only record.

### Apply

```sh
terraform init
terraform plan
terraform apply
```

Review the plan before applying. A plan without WAF and with one site creates 22 resources: the bucket and its configuration, the CloudFront distribution with its origin access control, routes function, response-headers policy and cache policies, the admin role and policy, one role and policy per site, and two `terraform_data` guards.

Outputs you will use:

| Output | Use |
| --- | --- |
| `aws_deployment_config_yaml` | The AWS target block for `artifact-pages.yaml`. |
| `admin_role_arn` | `role-to-assume` for the admin workflows. |
| `satellite_role_arns` | One role ARN per site, for the site workflows. |
| `distribution_domain_name` | The default CloudFront hostname, or the CNAME target. |
| `distribution_hosted_zone_id` | Route 53 alias records. |

### Costs

Costs have not been established, and this guide gives no figures. The module uses S3 and CloudFront, which bill by usage; check the [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/) and [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) pages for your region and expected traffic. Enabling WAF adds its own charges (see [AWS WAF pricing](https://aws.amazon.com/waf/pricing/)). The deployment README in the repository asks for a low, expected and high cost projection before an apply.

## 2. Configure the CLI

Paste the `aws_deployment_config_yaml` output into `artifact-pages.yaml` in the admin repository, then add the rest of the deployment config (CLI and web version pins and the complete `sites` mapping). The module output looks like this:

```yaml
schemaVersion: 1
provider: aws
aws:
  accountId: "123456789012"
  region: us-east-1
  bucket: artifact-pages-example
  distributionId: E1ABCDEFGHIJKL
```

`namePrefix` appears only when `name_prefix` is not the default. The file contains no credentials. Preview retention stays in the Terraform lifecycle settings and is not part of the CLI config.

AWS credentials do not come from keys stored in GitHub. Each workflow exchanges its GitHub OIDC token for temporary credentials by assuming a role with `aws-actions/configure-aws-credentials`, so the job needs `permissions: id-token: write` and `contents: read`. The admin workflows assume `admin_role_arn`. Each site workflow assumes that site's satellite role, whose ARN the CLI can derive from the config:

```sh
artifact-pages registry role-arn --config artifact-pages.yaml --site sre
```

The command runs locally and prints only the ARN. Register every site in the admin config's `sites` mapping before it publishes. Workflow templates are in [Optional GitHub Actions](github-actions.md) and `examples/github-actions`.

## 3. Deploy the app and register sites

Run the admin workflow first, because a site publish requires the site to be registered. From the admin repository, with the admin role's credentials, the commands are:

```sh
artifact-pages app deploy --config artifact-pages.yaml --dry-run
artifact-pages app deploy --config artifact-pages.yaml
artifact-pages registry sync --config artifact-pages.yaml --dry-run
artifact-pages registry sync --config artifact-pages.yaml
```

In a workflow, the same steps are `artifact-pages/app-deploy-action` and `artifact-pages/registry-action` after the credentials step, each with `config`, `dry-run` and `publish-on`, in a job that runs in the restricted environment. The verification workflows used `workflow_dispatch` with a `dry-run` input and the release tag `v0.2.0` of the Actions. App deploy writes the application files and then invalidates only the application shell (`/index.html`); hashed assets are immutable and need no invalidation. `registry sync` writes the registry for the complete `sites` mapping and removes the content of sites that are omitted from it.

Then each satellite repository publishes its own site with its satellite role:

```sh
artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml --dry-run
artifact-pages site sync --site sre --source docs/artifacts --config artifact-pages.yaml
```

A satellite workflow usually points `--config` at the admin config, pinned to a reviewed commit:

```sh
artifact-pages site sync \
  --site sre \
  --source docs/artifacts \
  --config 'github://example/platform-admin/artifact-pages.yaml?ref=0123456789abcdef0123456789abcdef01234567'
```

On an emptied bucket, the admin run bootstrapped the registry and the site run bootstrapped the site's lock, index and artifacts with no extra steps. Bootstrap on a bucket that Terraform has just created was not observed (see Limitations). To check for drift after a suspected out-of-band edit, add `--reconcile`.

To unregister a site, remove it from the admin config's `sites` mapping and run `registry sync` from the admin repository. To remove one preview group, run `preview remove --site sre --group pr:42` with the site's role; preview delete access is limited to that site's `_previews/<site>/` prefix. To remove the application files, run `app remove`.

### Cache invalidation

Unlike the Cloudflare flow, there is no cache token. After a change, the CLI calls CloudFront `CreateInvalidation` for the paths it changed and reports them as `invalidationPaths` in the JSON output (`--format json`). Both role kinds hold `cloudfront:CreateInvalidation` on the one distribution. On the verification deployment, an updated object became visible at the edge about 14 seconds after the update and an unregistered site about 10 seconds after, from one sample each; treat these as observations, not a guarantee.

The distribution also bounds shared-cache freshness: 60 seconds for `/_indexes/*`, 300 seconds for `/_artifacts/*`, zero for the application shell and `/_previews/*`, and the object's own `Cache-Control` (up to one year) under `/assets/*`. Preview objects under `_previews/` expire after `preview_retention_days` through an S3 lifecycle rule. S3 processes lifecycle rules asynchronously, so there is no exact deletion time. The module sets bucket versioning to Suspended.

## 4. Verify the deployed boundary

After publishing, check the delivery hostname directly (the default CloudFront hostname or your custom domain).

- `/` loads the app, and `/sre` or a nested path such as `/sre/reliability/summary` keeps its URL while serving the app shell.
- `/assets/<hashed-file>` is served as the original object.
- A missing object under `/_indexes/`, `/_artifacts/` or `/_previews/` returns a 404 (the page `/_errors/not-found.html`), not the app shell. Private S3 answers 403 or 404 for a missing key, and CloudFront maps both to that 404. With `viewer_protocol_policy = "https-only"`, plain HTTP also ends at that 404 page.
- `/_control` and keys such as `/_control/sites/sre/lock.json` have no content behavior, so they fall back to the app shell and expose no object bytes.
- Inspect the response headers of `index.html`, an index, an artifact and a hashed asset, and confirm the cache behavior above.
- Publish a change and confirm the new content is visible within the invalidation bound you accept.

The satellite role boundary was checked on the verification deployment: with a site's role, writes to a neighbouring site's `_artifacts` and `_indexes`, writes to the registry and the registry lock, writes to the application files, and deleting a neighbouring site's preview were each denied with AccessDenied. Run the same checks against your own deployment if the boundary matters to you.

Caveat when emptying the bucket: `/_errors/not-found.html` is an object managed by Terraform. `aws s3 rm --recursive` deletes it, and raw misses then return S3's 403 XML until the next `terraform apply` recreates it. Exclude `_errors/` when you empty the bucket, or re-apply afterwards.

For recovery from failed upgrades, interrupted publishes and stale locks, see the [operator recovery runbook](operator-recovery.md). Its CLI steps apply to AWS; the cache-purge, R2 credential and Terraform steps are Cloudflare-specific.

## Limitations

- **Apply permissions.** The minimum IAM permissions for applying the module are not established, and no least-privilege policy is provided.
- **Costs.** Not established; see the AWS pricing pages.
- **Not yet verified on AWS:**
  - bootstrap on a newly created bucket
  - a neighbouring site reading an existing object (the denied writes above are verified; reads of an existing neighbour object are not)
  - unregister and invalidation timing when run through the OIDC roles
  - preview publication and the preview Content Security Policy delivered by CloudFront
- **Viewer access.** Artifact Pages has no user identity or per-site permission model. The module's only viewer policy is the optional WAF input; any other edge policy is yours to configure and verify.
- **Preview scripts.** Preview HTML runs in an unsandboxed iframe on the application origin, and its scripts can reach the parent page. See the module README.
- **State migration.** Moving from the former root `infra/aws` configuration is a Terraform state-address migration, described in the module README.
- **Custom `name_prefix`.** A non-default `name_prefix` needs Action v0.2.0 or later (CLI 0.4.x), which reads `aws.namePrefix`; a custom prefix has not been exercised live.
- **Evidence.** [T15](../backlog/verification/T15-provider-delivery.md) owns the live delivery evidence and the open items.

## References

[AWS module README](../../terraform/modules/aws/README.md), [Route 53 consumer example](../../terraform/modules/aws/examples/route53-consumer), [GitHub OIDC subject reference](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims), [Restrict access to an Amazon S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/) and [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/).
