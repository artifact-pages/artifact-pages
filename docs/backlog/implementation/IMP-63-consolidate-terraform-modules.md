# IMP-63 — Consolidate the Terraform package contents into the monorepo

- Status: In progress
- Lanes: Terraform
- Depends on: [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) (decided 2026-10-06, option 1)
- Blocks: [IMP-64](IMP-64-generate-sync-terraform-packages.md), [IMP-38](IMP-38-terraform-registry-publication.md)

## Goal

Make `terraform/modules/cloudflare` and `terraform/modules/aws` supersets of the two package repositories, in the Registry module shape that the generator (IMP-64) copies. No package repository is modified; `admin` keeps its `208abf5` pin until IMP-65.

## Concrete diffs to resolve (observed 2026-10-06)

Cloudflare (package `terraform-cloudflare-artifact-pages` main `80b2198` vs `terraform/modules/cloudflare`):

- ISSUE-069: port the hostname-scoped `http_config_settings` ruleset `unchanged_delivery` (package commit `20fe2a2`, merged as `80b2198`, PR #1) and its test `modules/delivery/tests/waf_custom_rules.tftest.hcl`-style coverage.
- `delivery/main.tf` (about 210 changed lines) and `delivery/variables.tf` (about 94): hostname-scoped WAF custom rules and presets (`waf_custom_rules`, `https_only`, `ip_allowlist`; package commit `208abf5`) are missing in the monorepo.
- `retention/main.tf`, `variables.tf`: the package normalises lifecycle rules by ID (`lifecycle_rules_by_id`, `additional_lifecycle_rules`; commit `01a7473`); the monorepo has a fixed rule list including `abort-preview-multipart-uploads`, which the merged result must keep.
- `versions.tf`: monorepo pins the provider `= 5.24.0`, the package allows `>= 5.24.0, < 6.0.0`; choose the package form for a published module and keep deployments pinned by lock file.
- Registry-shape gaps in the monorepo: no root entry module (IMP-37: root `main.tf`, `variables.tf`, `outputs.tf`, `versions.tf` composing `delivery` and `retention`; output of registry-reader credential environment names, commit `d52a312`), no `examples/`, no `tests/` (`cli-contract`, migration and prevent-destroy fixtures, `cloudflare-contract.test.js`, `delivery-notices.test.js`), no `modules/` nesting, no package validation scripts (`scripts/validate.sh`, `check-package.py`), no Taskfile entries.
- Monorepo-only content to keep: `delivery/main.test.js`, `retention/.terraform.lock.hcl`, deployments `terraform/deployments/cloudflare` and `cloudflare-verify` (update them to the new layout).

AWS (package `terraform-aws-artifact-pages` main `dd0fcde` vs `terraform/modules/aws`; `main.tf` differs by about 145 lines, `variables.tf` 50, `README.md` 80, `outputs.tf` 5, `versions.tf` 4, `routes.js` identical):

- Package only: target account guard (`aws_caller_identity`, `terraform_data.target_account_guard`, `github_oidc_provider_arn` account match, `bucket_name` default `artifact-pages-<account>-<region>`), `aws_cloudfront_function.trusted_html_policy` with `trusted-html-policy.js` and the `trusted_html` flag per behavior, `viewer_protocol_policy` variable, WAF presets (`waf.tf`, `waf-validation.tf`, `waf_custom_rules` variable, `docs/waf.md`, `scripts/generate-waf.py`, `scripts/validate-waf.sh`, `tests/waf-console.test.js`), `modules/cloudflare-dns-acm` and its example/tests (IMP-39), consumer examples and tasks, `tests/cli-contract*`, `tests/aws-contract.test.js`, output `accountId` and `bucket` outputs by `.bucket`.
- Monorepo only: `_control/site-cache/*`, `_control/publish-state/*` and `_control/app-cache/retry.json` IAM scopes (journal and cache, IMP-49 and later); the `aws_cloudfront_response_headers_policy.artifact_csp` that replaced the CloudFront Function for the artifact CSP (2026-10-05, tested by `artifact-csp.test.js`); `routes.test.js`, `deployment.test.js`; the `provider "aws"` block in `versions.tf` (a published module should not declare a provider; move it to the deployment).
- Decisions to take inside this slice: artifact CSP via response headers policy (monorepo) or CloudFront Function (package), keeping the monorepo's CSP content and its test unless the package behaviour is shown to be required; keep the `_control/*` IAM scopes in the merged policy; keep the account guard.

## Acceptance criteria

- [ ] `terraform/modules/cloudflare` contains `unchanged_delivery` and the WAF presets, the retention convergence, the root entry module and the registry-reader outputs; a plan against the verification zone state shows only the expected additions.
- [ ] `terraform/modules/aws` contains the account guard, DNS/ACM composition, WAF presets and the monorepo `_control/*` IAM scopes and artifact CSP; each diff above is recorded as taken, dropped or deferred in the Results section.
- [ ] Both module directories have the Registry layout (root files, `modules/`, `examples/`, `tests/`, scripts) and pass the package validation and contract tests from the package repositories, run from the monorepo (Terraform fmt/validate, `terraform test`, Node tests).
- [ ] `terraform/deployments/*` and the monorepo CI use the new layout; existing monorepo tests still pass.
- [ ] ISSUE-069's acceptance criteria point at the monorepo module.
- [ ] The tree is a superset of both package repositories: a file-level comparison against `208abf5`/`80b2198` and `dd0fcde` lists no unexplained missing content.

## Results

Cloudflare half done in this slice (2026-10-07). AWS is deferred to a follow-up PR that starts after the `cli-sync-remove` work lands, because that work edits `terraform/modules/aws/**`; the AWS acceptance criteria and the AWS diffs listed above stay open.

### Cloudflare: taken, dropped, deferred

Base: package `80b2198` (includes `208abf5` WAF and `20fe2a2` unchanged delivery) copied into `terraform/modules/cloudflare` in Registry layout. Existing `delivery/` and `retention/` were moved with `git mv` to `modules/delivery` and `modules/retention`, then merged.

| Diff | Decision |
| --- | --- |
| ISSUE-069 `unchanged_delivery` (`http_config_settings`), `existing_config_rules`, `config_ruleset_name`, tests | Taken. |
| Hostname-scoped WAF custom rules and presets (`waf_custom_rules`, `https_only`, `ip_allowlist`, `208abf5`), `waf_custom_rules.tftest.hcl`, `modules/delivery/tests/waf_custom_rules.tftest.hcl`, prevent-destroy fixture | Taken. |
| Ruleset name inputs (`transform_ruleset_name`, `cache_ruleset_name`, `response_header_ruleset_name`) | Taken (package). |
| Trusted HTML CSP as `cloudflare_ruleset.trusted_html_resource_policy` (artifact and raw preview, static `https://` source) | Taken. The monorepo-only `artifact_response_policy` (scheme-following CSP, artifacts only) is dropped: the deployed state and addresses are the package's, and the package also covers raw previews. |
| Monorepo-only `control_boundary` firewall ruleset, `existing_firewall_rules`, `/_control` route exclusions | Dropped. The owner accepted control-to-SPA fallback instead of an edge block (T15) and the package removed the block in `0ca5eea`; the `http_request_firewall_custom` phase now belongs to the optional `waf_custom_rules`. `main.test.js` asserts the fallback. |
| Monorepo-only `cloudflare_r2_managed_domain.development` (disables `r2.dev`) | Initially dropped (not in the deployed state; the package left `r2.dev` unmanaged). Re-added after the owner decision of 2026-10-07 as `cloudflare_r2_managed_domain.development` (`enabled = false`, no variable) in `modules/delivery`, because enabling `r2.dev` would expose the whole bucket including `_control/*` past the zone rules without Terraform noticing. The provider resource cannot be imported or destroyed, so the first apply only creates it. See the follow-up note below. |
| Retention convergence (`lifecycle_rules_by_id`, `additional_lifecycle_rules`, `01a7473`) | Taken. The monorepo's separate `abort-preview-multipart-uploads` rule is merged into the single `expire-preview-objects` rule as in the package (same 7-day abort behaviour). The ID stays reserved by the `additional_lifecycle_rules` validation. A separate rule would diverge from the applied state and re-introduce the provider 5.26.0 read-back diff the package fixed. Owner to confirm. |
| `versions.tf` provider constraint | Taken: `>= 5.24.0, < 6.0.0` in every module; deployments keep the exact provider through their lock files (root `.terraform.lock.hcl` pins 5.26.0). |
| Root entry module, registry-reader outputs (`d52a312`), `examples/`, `tests/`, `scripts/validate.sh`, `scripts/check-package.py`, `Taskfile.yml`, `README.md`, `RELEASE.md`, `LICENSE`, `.gitignore` | Taken, with monorepo adaptations below. |
| `delivery/main.test.js` | Kept at `modules/delivery/main.test.js`, rewritten for the merged module (CSP, config rule, no control block, example composition) and passing. It reads `examples/cloudflare/` outside the module directory, so IMP-64's generator must exclude it from the package. |
| `retention/.terraform.lock.hcl` | Dropped. It pinned `= 5.24.0`, which no longer matches the constraint, and a submodule lock file is not used by consumers. |
| Callers: `examples/cloudflare/terraform`, `terraform/deployments/cloudflare`, `terraform/deployments/cloudflare-verify`, `docs/guides/cloudflare-deployment.md`, `docs/architecture/repository-layout.md`, root `package.json` (`test:provider-delivery`), root `Taskfile.yml` (`cloudflare-module:check`), `.github/workflows/verify.yml` (new `terraform-cloudflare` job) | Updated. Resource addresses did not change; no `moved` blocks were needed. |

Monorepo adaptations of package scripts: `scripts/validate.sh` defaults the Artifact Pages checkout to the repository root (override with `ARTIFACT_PAGES_APPREPO_DIR`); `tests/cli-contract/validator.go` imports `github.com/artifact-pages/artifact-pages/cli/internal/config`, uses `go.yaml.in/yaml/v3` and carries `//go:build ignore` so `go vet ./...` skips it (the script strips the constraint when copying it into the CLI tree); `scripts/check-package.py` handles a module that is a repository subdirectory. `RELEASE.md` and the Registry-address text in `README.md` are copied unchanged and left for IMP-64/IMP-38 to reconcile (module versions are independent of the product version, as RELEASE.md already states).

### Cloudflare verification

- `scripts/validate.sh` under Terraform 1.9.8 (fmt, init and validate of root and local example, root `terraform test` 9/9, `tests/cli-contract` 3/3, delivery submodule `terraform test` 19/19, prevent-destroy and lifecycle round-trip fixtures, `node --test tests/*.test.js` 12/12, module-address migration fixture with no changes): passed.
- `npm run test:provider-delivery` (AWS tests plus the Cloudflare module and delivery tests): 34/34.
- Read-only plan of `terraform/deployments/cloudflare-verify` (module now `../../modules/cloudflare`, Terraform 1.16.4, a copy of the verification state, no lock, no apply): `No changes`. This is stricter than the "expected additions" in the acceptance criteria because the verification zone was last applied from `80b2198`.
- File-level superset check against `80b2198` (all 51 package files): every file is present at the same relative path under `terraform/modules/cloudflare/`, byte-identical except for these deliberate differences: `scripts/validate.sh`, `scripts/check-package.py`, `tests/cli-contract/validator.go`, `tests/cli-validation-layout.test.js`, `README.md` (two validation sentences), `Taskfile.yml` (added `check`). Monorepo-only addition: `modules/delivery/main.test.js`. Nothing from the package is missing; the only monorepo-only content dropped is listed in the table above.

### Follow-up: r2.dev management re-added (2026-10-07)

PR: https://github.com/artifact-pages/artifact-pages/pull/39. `modules/delivery/main.tf` manages `cloudflare_r2_managed_domain.development` with `enabled = false`; tests (`modules/delivery/main.test.js`, `tests/cloudflare-contract.test.js`, `modules/delivery/tests/r2_dev_disabled.tftest.hcl`) assert it is managed and disabled. Read-only plan of `terraform/deployments/cloudflare-verify` against a copy of the verification state: `Plan: 1 to add, 0 to change, 0 to destroy.` (only the managed domain). Production receives it when `admin` switches to the monorepo-synced module (IMP-65); applying to the verification zone is an owner-approved step after merge. Applied to the verification zone on 2026-10-07 after owner approval: `Apply complete! Resources: 1 added, 0 changed, 0 destroyed.`, re-plan `No changes`, Cloudflare API reports `enabled: false` for `artifact-pages-verify`; state backups `cloudflare-verify-20261007T140012-pre-r2dev.tfstate` / `...T140137-post-r2dev.tfstate` in `~/.config/artifact-pages/state-backup/`.

### Still open

- AWS (all AWS diffs and acceptance criteria): follow-up PR after `cli-sync-remove` lands.
- The Cloudflare criterion "plan shows only the expected additions" is met as no changes against the verification state; production was not planned here.
- Generator (IMP-64) must exclude monorepo-only files (`modules/delivery/main.test.js`) and rewrite the Registry address if the namespace changes.
