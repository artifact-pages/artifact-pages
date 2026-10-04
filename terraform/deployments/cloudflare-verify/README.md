# Cloudflare verification deployment

This root deploys the working-tree Cloudflare module to the verification domain `artifact-pages.stream`, as described in [TD5](../../../docs/backlog/technical-design/TD5-verification-environment-and-operator-repositories.md). It is separate from production in four ways: its own state (`.local/terraform/cloudflare-verify/`), its own bucket (`artifact-pages-verify`), its own zone, and its own credentials. A zone guard in `main.tf` fails the plan for any zone other than `artifact-pages.stream`. The guard matters because mise skips a missing env file, and the shell may still hold production variables.

## Credentials

Create `~/.config/artifact-pages/verify.env` with mode 600. It holds two tokens:

```sh
# Terraform token: zone artifact-pages.stream (Zone Read, DNS Edit, Transform Rules
# Edit, Cache Rules Edit, Config Rules Edit, Zone WAF Edit) plus account Workers R2
# Storage Edit.
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_ZONE_ID=...
# CLI token: zone Cache Purge on artifact-pages.stream plus Workers R2 Storage
# Bucket Item Write on artifact-pages-verify only. The R2 key pair is derived from
# it: the access key ID is the token ID, and the secret is the SHA-256 of the token value.
CF_VERIFY_API_TOKEN=...
CF_VERIFY_R2_ACCESS_KEY_ID=...
CF_VERIFY_R2_SECRET_ACCESS_KEY=...
```

`mise.toml` loads the file in this directory only. The CLI reads the `CF_VERIFY_*` names that `artifact-pages.verify.yaml` selects. These names never collide with production variables.

## Infrastructure

```sh
cd terraform/deployments/cloudflare-verify
cp terraform.tfvars.example terraform.tfvars
mise exec -- terraform init
mise exec -- terraform plan -out=../../../.local/terraform/cloudflare-verify/plan.tfplan
mise exec -- terraform apply ../../../.local/terraform/cloudflare-verify/plan.tfplan
```

## Application and sites

Run the CLI from the repository root:

```sh
set -a; source ~/.config/artifact-pages/verify.env; set +a
artifact-pages registry register --config artifact-pages.verify.yaml
artifact-pages app deploy --config artifact-pages.verify.yaml
artifact-pages site publish --site smoke --config artifact-pages.verify.yaml
artifact-pages preview publish --site smoke --source fixtures/actions-smoke/site \
  --default-ref origin/main --base-url https://artifact-pages.stream --config artifact-pages.verify.yaml
```
