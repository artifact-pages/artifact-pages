#!/usr/bin/env bash
# Sync one generated Terraform package and create its plain vX.Y.Z tag.
#
#   scripts/sync-terraform-package-repos.sh BUILT_DIR MODULE X.Y.Z [--dry-run]
#
# Environment:
#   TERRAFORM_PACKAGE_REPO_TOKEN       GitHub App installation token (contents:write)
#   TERRAFORM_PACKAGE_REPO_URL_BASE   override for local git fixtures
#   SOURCE_SHA                         full monorepo source commit
#   DRY_RUN                            true to print the plan without pushing
#
# Existing package tags are immutable. Re-running an identical tag is a no-op.
set -euo pipefail

built="${1:?usage: sync-terraform-package-repos.sh BUILT_DIR MODULE X.Y.Z [--dry-run]}"
module="${2:?usage: sync-terraform-package-repos.sh BUILT_DIR MODULE X.Y.Z [--dry-run]}"
version="${3:?usage: sync-terraform-package-repos.sh BUILT_DIR MODULE X.Y.Z [--dry-run]}"
case "$module" in
  cloudflare) repository="terraform-cloudflare-artifact-pages" ;;
  aws) repository="terraform-aws-artifact-pages" ;;
  *) echo "unknown Terraform module: $module" >&2; exit 1 ;;
esac
[[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || { echo "version must be plain X.Y.Z without prerelease or build metadata" >&2; exit 1; }
tag="v${version}"
package="$built/$repository"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_tag="terraform-${module}/${tag}"
dry_run="${DRY_RUN:-false}"
if [[ "${4:-}" == "--dry-run" ]]; then dry_run=true; fi
if [[ "$dry_run" != true && "$dry_run" != false ]]; then echo "DRY_RUN must be true or false" >&2; exit 1; fi
[[ -d "$package" ]] || { echo "generated package directory not found: $package" >&2; exit 1; }

metadata="$(node --input-type=module - "$package/release.json" "$module" "$version" "$source_tag" "$repository" <<'JS'
import { readFileSync } from 'node:fs'
const [file, module, version, sourceTag, repository] = process.argv.slice(2)
const record = JSON.parse(readFileSync(file, 'utf8'))
const sha = /^[0-9a-f]{40}$/
if (record.schemaVersion !== 1 || record.version !== version || record.repository !== `artifact-pages/${repository}`
  || record.sourceTag !== sourceTag || !sha.test(record.sourceCommit ?? '')) {
  console.error('release.json does not match the selected module, version, source tag, and source commit')
  process.exit(1)
}
if (module !== sourceTag.split('/')[0].slice('terraform-'.length)) process.exit(1)
process.stdout.write(record.sourceCommit)
JS
)" || { echo "invalid generated package metadata" >&2; exit 1; }
source_sha="${SOURCE_SHA:-$metadata}"
if [[ "$source_sha" != "$metadata" ]]; then echo "SOURCE_SHA does not match release.json sourceCommit" >&2; exit 1; fi

if [[ -n "${TERRAFORM_PACKAGE_REPO_URL_BASE:-}" ]]; then
  base="${TERRAFORM_PACKAGE_REPO_URL_BASE%/}"
elif [[ -n "${TERRAFORM_PACKAGE_REPO_TOKEN:-}" ]]; then
  base="https://github.com/artifact-pages"
  basic="$(printf 'x-access-token:%s' "$TERRAFORM_PACKAGE_REPO_TOKEN" | base64 | tr -d '\n')"
  export GIT_CONFIG_COUNT=1
  export GIT_CONFIG_KEY_0='http.https://github.com/.extraheader'
  export GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $basic"
else
  echo "TERRAFORM_PACKAGE_REPO_TOKEN or TERRAFORM_PACKAGE_REPO_URL_BASE is required" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
clone="$work/$repository"
url="$base/$repository.git"
git clone --quiet "$url" "$clone" 2>/dev/null || { echo "cannot clone $repository" >&2; exit 1; }
git_identity=(-c user.name="artifact-pages release" -c user.email="41898282+github-actions[bot]@users.noreply.github.com")

if git -C "$clone" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  git -C "$clone" fetch --quiet origin "refs/tags/$tag:refs/tags/$tag"
  git -C "$clone" -c advice.detachedHead=false checkout --quiet "$tag"
  if node --input-type=module - "$project_root/scripts/terraform-package-content.mjs" "$package" "$clone" <<'JS'
import { pathToFileURL } from 'node:url'
const [contentScript, expected, actual] = process.argv.slice(2)
const { terraformPackageDirectoryHash } = await import(pathToFileURL(contentScript))
process.exit(terraformPackageDirectoryHash(expected) === terraformPackageDirectoryHash(actual) ? 0 : 1)
JS
  then
    echo "$repository: $tag already published with identical content"
    exit 0
  fi
  echo "$repository: $tag already exists with different content; published tags are immutable" >&2
  exit 1
fi

node "$project_root/scripts/terraform-package-content.mjs" \
  --current "$package" \
  --repository-dir "$clone" \
  --version "$version" \
  --repository "artifact-pages/$repository"

if git -C "$clone" show-ref --verify --quiet refs/remotes/origin/main; then
  git -C "$clone" checkout --quiet -B main origin/main
else
  git -C "$clone" checkout --quiet --orphan main
  git -C "$clone" rm -r -q --ignore-unmatch . >/dev/null 2>&1 || true
fi

# Remove tracked and untracked leftovers, then install the generated tree including dotfiles.
if git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null; then
  git -C "$clone" rm -r -q --ignore-unmatch . >/dev/null
fi
find "$clone" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$package"/. "$clone"/
git -C "$clone" add -A
if ! git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null || ! git -C "$clone" diff --cached --quiet; then
  git -C "$clone" "${git_identity[@]}" commit --quiet -m "Sync $tag from $source_tag at $source_sha"
fi
planned_commit="$(git -C "$clone" rev-parse HEAD)"

if [[ "$dry_run" == true ]]; then
  printf '%s: dry-run planned main %s and tag %s from %s at %s\n' "$repository" "$planned_commit" "$tag" "$source_tag" "$source_sha"
  exit 0
fi

git -C "$clone" "${git_identity[@]}" -c tag.gpgSign=false tag -a "$tag" -m "$repository $tag"
git -C "$clone" push --quiet --atomic origin main "refs/tags/$tag"
printf '%s: published %s at %s\n' "$repository" "$tag" "$planned_commit"
