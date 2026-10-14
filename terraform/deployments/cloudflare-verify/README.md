# Cloudflare verification deployment

This root deploys the working-tree Cloudflare module to the verification domain `artifact-pages.stream`, as described in [TD5](../../../docs/backlog/technical-design/TD5-verification-environment-and-operator-repositories.md). It is separate from production in five ways: its own Cloudflare account (`artifact-pages-verify`), its own remote state key (`cloudflare-verify`), its own bucket (`artifact-pages-verify`), its own zone, and its own credentials. A zone guard in `main.tf` fails the plan for any zone other than `artifact-pages.stream`. The guard matters because mise skips a missing env file, and the shell may still hold production variables.

It runs in its own Cloudflare account, `artifact-pages-verify`, and keeps its Terraform state in that account; nothing here needs production credentials.

## Credentials

1. Create the verification credentials directory:

   ```sh
   install -d -m 700 ~/.config/artifact-pages-verify
   ```

2. In the verification account, create the Terraform token scoped to the verification account and zone `artifact-pages.stream` (Zone Read, DNS Edit, Transform Rules Edit, Cache Rules Edit, Config Rules Edit, Zone WAF Edit) plus Workers R2 Storage Edit in that account. Write `~/.config/artifact-pages-verify/verify.env` with mode 600, containing only these three assignments:

   ```sh
   CLOUDFLARE_API_TOKEN=...
   CLOUDFLARE_ACCOUNT_ID=...
   CLOUDFLARE_ZONE_ID=...
   ```

Set `CLOUDFLARE_ACCOUNT_ID` to the verification account ID `21a0acb78621cc00cfa655a276d77b74`. `mise.toml` loads this file in this directory only. The CLI reads the `CF_VERIFY_*` names that `artifact-pages.verify.yaml` selects. These names never collide with production variables.

3. In the verification account, create the private R2 bucket `tfstate` and an R2 API token with Object Read & Write on that bucket only. Write `~/.config/artifact-pages-verify/tfstate-aws-credentials` with mode 600 in this exact format:

   ```ini
   [artifact-pages-verify-tfstate]
   aws_access_key_id = ...
   aws_secret_access_key = ...
   ```

Terraform state is stored in this bucket with conditional locking. Do not reuse the production `artifact-pages-tfstate` profile or `ops/OPS-004` credentials. Do not source `tfstate.env` into Terraform. Run `mise exec` from this deployment directory so the verification variables are loaded.

## Infrastructure

4. Initialize, plan, and apply from this deployment directory:

   ```sh
   cd terraform/deployments/cloudflare-verify
   cp terraform.tfvars.example terraform.tfvars
   mise exec terraform@1.16.4 -- terraform init
   umask 077
   mkdir -p ../../../.local/terraform/cloudflare-verify
   mise exec terraform@1.16.4 -- terraform plan -out=../../../.local/terraform/cloudflare-verify/plan.tfplan
   mise exec terraform@1.16.4 -- terraform apply ../../../.local/terraform/cloudflare-verify/plan.tfplan
   ```

State moved to the verification account on 2026-10-14 (OPS-007); the deployment was rebuilt from empty state, and the old production-account key is not used.

5. After apply, in the verification account create the CLI token with zone Cache Purge on `artifact-pages.stream` plus Workers R2 Storage Bucket Item Write on `artifact-pages-verify` only. Append these three assignments to `~/.config/artifact-pages-verify/verify.env`:

   ```sh
   CF_VERIFY_API_TOKEN=...
   CF_VERIFY_R2_ACCESS_KEY_ID=...
   CF_VERIFY_R2_SECRET_ACCESS_KEY=...
   ```

   The R2 key pair is derived from the CLI token: the access key ID is the token ID, and the secret is the SHA-256 of the token value.

## Application and sites

6. Run the CLI from the repository root:

   ```sh
   set -a; source ~/.config/artifact-pages-verify/verify.env; set +a
   artifact-pages registry sync --config artifact-pages.verify.yaml
   artifact-pages app deploy --config artifact-pages.verify.yaml
   artifact-pages site sync --site smoke --config artifact-pages.verify.yaml
   artifact-pages preview publish --site smoke --source fixtures/actions-smoke/site \
     --default-ref origin/main --base-url https://artifact-pages.stream --config artifact-pages.verify.yaml
   ```
