# Cloudflare edge features rewrite delivered artifact HTML

- Status: Done
- Priority: P1
- Area: Cloudflare delivery, Terraform module

## Problem

On production (`artifact-pages.dev`) the Cloudflare-proxied hostname altered published HTML. Email Address Obfuscation (Scrape Shield, on by default for new zones) rewrote `git-artifact-pages@vX.Y.Z` in a code example to `[email protected]` and injected an email-decode script, so delivered bytes no longer matched Git. The product contract is that published HTML, production and preview, is delivered unchanged. Other body-rewriting edge features (Rocket Loader, Automatic HTTPS Rewrites, Fonts, analytics injection, Polish) can break the same contract.

## Evidence and reproduction

1. On 2026-10-03, compare `guide/en/publishing.html` served from `https://artifact-pages.dev/` with the Git blob for the same path.
2. Observed before the fix: remote SHA-256 prefix `e8f3bc09`, Git `54509747`.
3. The remote body contained `__cf_email__` markup and an injected `/cdn-cgi/scripts/.../email-decode.min.js` script; `[email protected]` replaced the version pin.
4. `/cdn-cgi/l/email-protection` returned 404 on the hostname, so the obfuscated address could not be decoded by a link either.
5. The owner turned Email Address Obfuscation off zone-wide in the dashboard on 2026-10-03 as a stopgap. Hashes now match. The setting is unmanaged and zone-wide, so it can regress and affects other hostnames in the zone.

6. Checked 2026-10-06: all 24 guide and architecture HTML pages served from `https://artifact-pages.dev/_artifacts/` hash equal to the sources in `artifact-pages/docs`, with no `__cf_email__` or `/cdn-cgi/` markup. This holds because of the dashboard stopgap, not the module: the admin pin is still `208abf5`, so the fix is not applied (admin PR #7 bumps it to `80b2198`, the merge of module PR #1).
7. The monorepo `terraform/modules/cloudflare` does not contain the `http_config_settings` fix; it exists only in the published package repository, which `admin` consumes by git ref. [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) (2026-10-06) chose the monorepo as the source, so [IMP-63](../implementation/IMP-63-consolidate-terraform-modules.md) ports it to the monorepo module (done for Cloudflare, see item 11); the package repository is then generated. Original note: port it to the monorepo module or retire the monorepo copy so the two cannot diverge. Tracked as [TD15](../technical-design/TD15-terraform-module-source-of-truth.md) (owner decision pending).

8. Applied 2026-10-06: admin PR #7 merged (module pin `80b2198`, module PR #1). A production `terraform apply` from `admin/terraform` created `cloudflare_ruleset.unchanged_delivery` (phase `http_config_settings`, ruleset id `b0f6d6c4b6f74f658e7e3aac8b9e4208`, scoped to the `artifact-pages.dev` host) which disables email obfuscation, Rocket Loader, Automatic HTTPS Rewrites, Fonts, RUM, Zaraz, Content Converter and Polish, plus the semantically unchanged R2 lifecycle. A re-plan reported no changes. The token needed only Zone Settings edit, not a separate Config Rules permission.
9. With the rule in place, zone-wide Email Obfuscation was switched back on and the cache purged. All 24 guide and architecture HTML files fetched from `https://artifact-pages.dev/_artifacts/` were byte-identical (SHA-256) to the sources in `artifact-pages/docs`, with 0 occurrences of `__cf_email__` or `/cdn-cgi/`.
10. Applied 2026-10-06 to the verification zone `artifact-pages.stream` (zone `b647a1ef28dde558fa8b80b50ad0c040`): `terraform apply` in `terraform/deployments/cloudflare-verify` created `cloudflare_ruleset.unchanged_delivery` (id `d09e028ab0d040769b38879b8ed3a527`, expression `lower(http.host) eq "artifact-pages.stream"`) and the R2 lifecycle. A re-plan reported no changes and the state was backed up. The monorepo `terraform/modules/cloudflare` copy lacked the fix until IMP-63 (item 11).
11. IMP-63 (Cloudflare) ported `unchanged_delivery` into the monorepo module `terraform/modules/cloudflare/modules/delivery/main.tf` with its tests (`waf_custom_rules.tftest.hcl` coverage and `tests/cloudflare-contract.test.js`), and `terraform/deployments/cloudflare*` now source it. A read-only `terraform plan` of the verification deployment against the existing state reported no changes.

Confirmed: email obfuscation rewrote the body. Not yet confirmed on production: whether the other features rewrite artifact bodies today; the module disables them as a precaution.

## Expected outcome

The Terraform module owns an `http_config_settings` rule scoped to the Artifact Pages hostname that disables the body-rewriting features, and delivered artifact and preview bytes equal the published objects without any dashboard setting.

## Acceptance criteria

- [x] The module change (originally terraform-cloudflare-artifact-pages PR #1, now carried by the monorepo module `terraform/modules/cloudflare/modules/delivery`, resource `cloudflare_ruleset.unchanged_delivery`) is merged and applied to the verification zone, then production. Merged and applied to production on 2026-10-06 (the token needed only Zone Settings edit) and to the verification zone on 2026-10-06 (item 10). IMP-63 ported the rule to the monorepo module, and a read-only plan of `terraform/deployments/cloudflare-verify`, now sourced from `terraform/modules/cloudflare`, reports no changes against the verification state.
- [x] With the zone-wide dashboard setting restored to its default, `guide/en/publishing.html` served from production hashes equal to the Git blob and contains no `__cf_email__` or `/cdn-cgi/` script.
- [x] A raw preview HTML object on production also hashes equal to its published bytes. Verified 2026-10-06, see Preview verification.
- [x] `docs/specification.md` states the unchanged-delivery contract (stated in the delivery section).

## Preview verification (2026-10-06)

With the host-scoped `unchanged_delivery` Config Rule applied on production and zone-wide Email Obfuscation back ON, a throwaway docs PR (artifact-pages/docs#15, closed without merging) added an HTML comment and a visible `verify-069@example.com` line to `sites/guide/en/getting-started.html` and was previewed through the Preview workflow (head `248560cc17a4b774926c3f593c0db143e5c6f3a9`).

- Reader URL: `https://artifact-pages.dev/guide/_previews/248560cc17a4b774926c3f593c0db143e5c6f3a9/en/getting-started.html?group=pr%3A15`
- Raw object: `https://artifact-pages.dev/_previews/guide/revisions/248560cc17a4b774926c3f593c0db143e5c6f3a9/files/en/getting-started.html` (HTTP 200, `text/html; charset=utf-8`)
- SHA-256 of the served bytes and of the Git blob at the head SHA: `75ee479557813a89e424fa9be13752a4b9699c9d32a0bd4e5667dc1c18c21796` (`cmp` identical).
- `__cf_email__` count 0, `/cdn-cgi/` count 0; the visible address and the comment remain literal.
