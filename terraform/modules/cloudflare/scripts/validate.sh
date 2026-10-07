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

# Inside the monorepo (terraform/modules/cloudflare) the CLI checkout is the repository root;
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
contract_helper_dir="$(mktemp -d "$apprepo_dir/cli/.local/terraform-cloudflare-contract.XXXXXX")"
sed '/^\/\/go:build ignore$/d' "$module_root/tests/cli-contract/validator.go" > "$contract_helper_dir/main.go"
export TF_VAR_apprepo_dir="$apprepo_dir"
export TF_VAR_cli_contract_helper="$contract_helper_dir/main.go"

temporary_root="$(mktemp -d /tmp/cloudflare-module-validation.XXXXXX)"
trap 'rm -r "$temporary_root" "$contract_helper_dir"' EXIT

"$terraform_bin" fmt -check -recursive
"$terraform_bin" init -backend=false -input=false -lockfile=readonly
"$terraform_bin" validate
"$terraform_bin" test -no-color
"$terraform_bin" -chdir=examples/local-consumer init -backend=false -input=false -lockfile=readonly
"$terraform_bin" -chdir=examples/local-consumer validate
"$terraform_bin" -chdir=tests/cli-contract init -backend=false -input=false -lockfile=readonly
"$terraform_bin" -chdir=tests/cli-contract test -no-color

waf_delivery_test_root="$temporary_root/delivery"
mkdir -p "$waf_delivery_test_root"
cp -R "$module_root/modules/delivery/." "$waf_delivery_test_root/"
cp "$module_root/.terraform.lock.hcl" "$waf_delivery_test_root/.terraform.lock.hcl"
"$terraform_bin" -chdir="$waf_delivery_test_root" init -backend=false -input=false -lockfile=readonly
"$terraform_bin" -chdir="$waf_delivery_test_root" test -no-color
TERRAFORM_BIN="$terraform_bin" bash "$module_root/tests/test-waf-prevent-destroy.sh"
TERRAFORM_BIN="$terraform_bin" python3 "$module_root/tests/test-retention-roundtrip.py"

node --test tests/*.test.js

migration_root="$temporary_root/migration"
mkdir -p "$migration_root/work/modules"
cp -R tests/fixtures/module-migration/modules/. "$migration_root/work/modules/"
cp tests/fixtures/module-migration/old.tf "$migration_root/work/main.tf"
"$terraform_bin" -chdir="$migration_root/work" init -backend=false -input=false
"$terraform_bin" -chdir="$migration_root/work" apply -auto-approve -input=false
cp tests/fixtures/module-migration/new.tf "$migration_root/work/main.tf"
"$terraform_bin" -chdir="$migration_root/work" init -backend=false -input=false
"$terraform_bin" -chdir="$migration_root/work" state mv 'module.artifact_pages_delivery' 'module.artifact_pages.module.delivery'
"$terraform_bin" -chdir="$migration_root/work" state mv 'module.preview_retention' 'module.artifact_pages.module.retention'
"$terraform_bin" -chdir="$migration_root/work" plan -input=false -lock=false -detailed-exitcode
