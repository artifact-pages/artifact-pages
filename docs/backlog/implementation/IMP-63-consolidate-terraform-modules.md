# IMP-63 — Consolidate the Terraform package contents into the monorepo

- Status: Open
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

Not started.
