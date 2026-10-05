#!/usr/bin/env bash
# Publishes the generated Action repositories (scripts/build-action-repos.mjs) and tags
# each with the product version (TD14).
#
#   scripts/sync-action-repos.sh BUILT_DIR X.Y.Z
#
# Environment:
#   ACTION_REPO_TOKEN     GitHub App installation token with contents:write on the four repositories
#   ACTION_REPO_URL_BASE  repository URL prefix (default: https://x-access-token:$ACTION_REPO_TOKEN@github.com/artifact-pages);
#                         tests point it at local bare repositories
#   SOURCE_SHA            product commit recorded in the sync commit message (optional)
#
# For every <name>-action directory in BUILT_DIR: when tag vX.Y.Z already exists the
# repository must hold identical content (a re-run is a no-op, a difference fails: tags
# are never moved); otherwise the main branch is replaced by the generated content,
# committed, tagged and pushed together. Safe to re-run after a partial failure.
set -euo pipefail

built="${1:?usage: sync-action-repos.sh BUILT_DIR X.Y.Z}"
version="${2:?usage: sync-action-repos.sh BUILT_DIR X.Y.Z}"
tag="v${version}"
base="${ACTION_REPO_URL_BASE:-https://x-access-token:${ACTION_REPO_TOKEN:?ACTION_REPO_TOKEN or ACTION_REPO_URL_BASE is required}@github.com/artifact-pages}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git_identity=(-c user.name="artifact-pages release" -c user.email="41898282+github-actions[bot]@users.noreply.github.com")

shopt -s nullglob
repos=("$built"/*-action)
if [ "${#repos[@]}" -eq 0 ]; then
  echo "no *-action directories in $built" >&2
  exit 1
fi

for dir in "${repos[@]}"; do
  name="$(basename "$dir")"
  clone="$work/$name"
  git clone --quiet "$base/$name" "$clone" 2>/dev/null || { echo "cannot clone $name" >&2; exit 1; }

  if git -C "$clone" ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
    git -C "$clone" fetch --quiet origin "refs/tags/$tag:refs/tags/$tag"
    git -C "$clone" -c advice.detachedHead=false checkout --quiet "$tag"
    if diff -r --exclude=.git "$dir" "$clone" >/dev/null; then
      echo "$name: $tag already published with identical content"
      continue
    fi
    echo "$name: $tag already exists with different content; tags are never moved" >&2
    exit 1
  fi

  git -C "$clone" checkout --quiet -B main
  if git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null; then
    git -C "$clone" rm -r -q --ignore-unmatch . >/dev/null
  fi
  # Remove untracked leftovers, then copy the generated tree (dotfiles included).
  find "$clone" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
  cp -R "$dir"/. "$clone"/
  git -C "$clone" add -A
  if ! git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null || ! git -C "$clone" diff --cached --quiet; then
    git -C "$clone" "${git_identity[@]}" commit --quiet -m "Sync ${tag} from artifact-pages/artifact-pages${SOURCE_SHA:+ at ${SOURCE_SHA}}"
  fi
  git -C "$clone" "${git_identity[@]}" tag -a "$tag" -m "$name $tag"
  git -C "$clone" push --quiet --atomic origin main "refs/tags/$tag"
  echo "$name: published $tag ($(git -C "$clone" rev-parse --short HEAD))"
done
