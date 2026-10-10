# Cloudflare package release

The editable source of truth is [`terraform/modules/cloudflare`](.) in the `artifact-pages/artifact-pages` monorepo. The public Registry package repository, `artifact-pages/terraform-cloudflare-artifact-pages`, is generated from that tree. Do not edit or push module source directly to the package repository. The `terraform-aws/vX.Y.Z` series is independent and uses the corresponding AWS module and repository.

## Local candidate validation

Use a clean checkout of the selected source commit on `main`. Run the module's `scripts/validate.sh` under Terraform 1.9.8, then generate the package into a temporary directory and run the generated package's `scripts/validate.sh` with `ARTIFACT_PAGES_APPREPO_DIR` set to the monorepo root. CI runs the same generated-package validation for both providers without Cloudflare or AWS credentials. The generator copies only tracked module files, preserves executable modes, rewrites the Registry consumer example to the Registry address and exact module version, and adds `release.json`, the generated notice, and the package PR auto-close workflow.

Package no-op detection compares the whole generated tree, including the README, `LICENSE`, workflow files and executable modes. It ignores only the release version/source metadata and the Registry consumer's exact version line when checking whether a new version changes payload. Prerelease and build-metadata suffixes are rejected; module release tags use plain `X.Y.Z`, matching the package repository's `vX.Y.Z` tag. Each provider starts at `0.1.0`.

## Owner-approved module release

After source review and explicit approval for the exact tag and sync, push `terraform-cloudflare/vX.Y.Z` on a commit already merged to `main`. `.github/workflows/release-terraform.yml` checks main ancestry and the package repository's version series, generates and validates the package, then replaces that package repository's `main` and creates its immutable plain `vX.Y.Z` tag. The product `release.yml` does not run for module tags. The owner installed `artifact-pages-release` on both package repositories with Contents write and Metadata read; the generated PR guard uses the package repository's own `GITHUB_TOKEN` and does not require App Pull requests write.

`workflow_dispatch` accepts an existing module tag only with `dry_run: true`; it validates the generated package and prints a sync plan without pushing. If that package tag was already synced, the retry reports the identical-tag no-op instead. Local git-fixture tests cover the planned commit/tag, selected-repository isolation, identical retry, immutable-tag rejection, and unchanged-payload guard. A real first tag/sync and test PR have not yet been run; verify the package repository's `main`, `vX.Y.Z` tag, and `release.json` source metadata after the approved release, then open a test PR to confirm the auto-close workflow before closing IMP-64.

## Terraform Registry publication

Registry connection and publication are a separate owner-controlled action tracked by IMP-38. Before publication, verify the package repository's public visibility and description, connect `artifact-pages/terraform-cloudflare-artifact-pages` in Terraform Registry, publish the approved exact version, and retrieve that version from a clean consumer. Record the source tag/commit, Registry version, provider lock resolution and retrieval evidence in T16. Never overwrite or move a published tag.

For an upgrade, callers pin an exact module version, preserve their provider lockfile, back up state securely, and inspect a fresh plan before applying. Read the root README's ownership and migration guidance: changes to the zone Configuration Rules root require importing and preserving existing rules, and enabling WAF rules transfers ownership of the complete custom-firewall phase root. Reverting a module source does not reverse Terraform state changes. A module-only release does not require a new web-app version or app deployment.
