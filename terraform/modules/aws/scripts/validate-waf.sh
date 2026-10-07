#!/usr/bin/env bash
set -euo pipefail
terraform_bin="${TERRAFORM_BIN:-terraform}"
module_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$module_root"
"$terraform_bin" fmt -check -recursive
"$terraform_bin" init -backend=false -input=false -lockfile=readonly
"$terraform_bin" validate
for caller in examples/local-consumer examples/cloudflare-dns-acm-consumer; do
  "$terraform_bin" -chdir="$caller" init -backend=false -input=false -lockfile=readonly
  "$terraform_bin" -chdir="$caller" validate
done
TERRAFORM_BIN="$terraform_bin" node --test tests/aws-contract.test.js tests/waf-console.test.js
