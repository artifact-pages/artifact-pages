#!/usr/bin/env bash
set -euo pipefail

terraform_bin="${TERRAFORM_BIN:-terraform}"
fixture_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/fixtures/waf-prevent-destroy" && pwd)"
temporary_root="$(mktemp -d /tmp/cloudflare-waf-destroy-guard.XXXXXX)"
trap 'rm -rf "$temporary_root"' EXIT

cp "$fixture_dir/main.tf" "$temporary_root/main.tf"
"$terraform_bin" -chdir="$temporary_root" init -backend=false -input=false -no-color
"$terraform_bin" -chdir="$temporary_root" apply -auto-approve -input=false -no-color -var='enabled=true'

if "$terraform_bin" -chdir="$temporary_root" plan -input=false -no-color -var='enabled=false' >"$temporary_root/plan.log" 2>&1; then
  cat "$temporary_root/plan.log"
  printf 'Expected prevent_destroy to reject disabling the stateful local resource.\n' >&2
  exit 1
fi

if ! grep -Fq 'prevent_destroy' "$temporary_root/plan.log"; then
  cat "$temporary_root/plan.log"
  printf 'The local plan failed for a reason other than prevent_destroy.\n' >&2
  exit 1
fi

printf 'Stateful local plan rejected the destruction with prevent_destroy.\n'
