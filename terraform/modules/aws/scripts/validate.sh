#!/usr/bin/env bash
set -euo pipefail

terraform_bin="${TERRAFORM_BIN:-terraform}"
terraform_version="$($terraform_bin version -json | node -e 'let input="";process.stdin.on("data",chunk=>input+=chunk).on("end",()=>process.stdout.write(JSON.parse(input).terraform_version))')"
if [[ "$terraform_version" != "1.9.8" ]]; then
  printf 'Expected Terraform 1.9.8, got %s\n' "$terraform_version" >&2
  exit 1
fi

module_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$module_root"

# Inside the monorepo (terraform/modules/aws) the CLI checkout is the repository root;
# in a generated package repository set ARTIFACT_PAGES_APPREPO_DIR to an Artifact Pages checkout.
if [[ -n "${ARTIFACT_PAGES_APPREPO_DIR:-}" ]]; then
  apprepo_dir="$ARTIFACT_PAGES_APPREPO_DIR"
elif [[ -f "$module_root/../../../cli/internal/config/config.go" ]]; then
  apprepo_dir="$module_root/../../.."
else
  apprepo_dir="$module_root/../artifact-pages"
fi
apprepo_dir="$(cd "$apprepo_dir" && pwd)"
if [[ ! -f "$apprepo_dir/go.mod" || ! -f "$apprepo_dir/cli/internal/config/config.go" ]]; then
  printf 'Artifact Pages checkout not found; set ARTIFACT_PAGES_APPREPO_DIR.\n' >&2
  exit 1
fi

export TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-/tmp/terraform-provider-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR" "$apprepo_dir/cli/.local"
# Go internal packages may only be imported from within the CLI subtree.
contract_helper_dir="$(mktemp -d "$apprepo_dir/cli/.local/terraform-aws-contract.XXXXXX")"
sed '/^\/\/go:build ignore$/d' "$module_root/tests/cli-contract/validator.go" > "$contract_helper_dir/main.go"
export TF_VAR_apprepo_dir="$apprepo_dir"
export TF_VAR_cli_contract_helper="$contract_helper_dir/main.go"

trap 'rm -r "$contract_helper_dir"' EXIT

"$terraform_bin" fmt -check -recursive
"$terraform_bin" init -backend=false -input=false -lockfile=readonly
"$terraform_bin" validate
"$terraform_bin" -chdir=examples/local-consumer init -backend=false -input=false -lockfile=readonly
"$terraform_bin" -chdir=examples/local-consumer validate
"$terraform_bin" -chdir=examples/cloudflare-dns-acm-consumer init -backend=false -input=false -lockfile=readonly
"$terraform_bin" -chdir=examples/cloudflare-dns-acm-consumer validate
"$terraform_bin" -chdir=tests/cli-contract init -backend=false -input=false -lockfile=readonly
"$terraform_bin" -chdir=tests/cli-contract test -no-color
"$terraform_bin" -chdir=tests/cli-contract-mismatch init -backend=false -input=false -lockfile=readonly
set +e
mismatch_output=$("$terraform_bin" -chdir=tests/cli-contract-mismatch test -no-color 2>&1)
mismatch_status=$?
set -e
if [[ "$mismatch_status" -eq 0 ]] || ! printf '%s' "$mismatch_output" | grep -Eq 'The AWS provider account must match the account ID in'; then
  printf '%s\n' "$mismatch_output" >&2
  printf 'Expected the mocked AWS account mismatch to stop the Terraform plan.\n' >&2
  exit 1
fi
printf 'Mocked AWS provider/OIDC account mismatch was rejected during planning.\n'

"$terraform_bin" -chdir=tests/cloudflare-dns-acm-account init -backend=false -input=false -lockfile=readonly
check_wrapper_account_mismatch() {
  local test_file="$1"
  local mismatch_output
  local mismatch_status

  set +e
  mismatch_output=$("$terraform_bin" -chdir=tests/cloudflare-dns-acm-account test -no-color -filter="$test_file" 2>&1)
  mismatch_status=$?
  set -e
  if [[ "$mismatch_status" -eq 0 ]] || ! printf '%s' "$mismatch_output" | grep -Eq 'Both AWS provider accounts must match the OIDC account\.'; then
    printf '%s\n' "$mismatch_output" >&2
    printf 'Expected mocked wrapper account mismatch to stop plan in %s.\n' "$test_file" >&2
    exit 1
  fi
  printf 'Mocked AWS account mismatch rejected by the Cloudflare/ACM wrapper: %s\n' "$test_file"
}
check_wrapper_account_mismatch default-provider-mismatch.tftest.hcl
check_wrapper_account_mismatch us-east-1-provider-mismatch.tftest.hcl

node --test tests/*.test.js
