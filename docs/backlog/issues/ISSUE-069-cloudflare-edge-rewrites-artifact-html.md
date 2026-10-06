# Cloudflare edge features rewrite delivered artifact HTML

- Status: Open
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
7. The monorepo `terraform/modules/cloudflare` does not contain the `http_config_settings` fix; it exists only in the published package repository, which `admin` consumes by git ref. Port it to the monorepo module or retire the monorepo copy so the two cannot diverge.

Confirmed: email obfuscation rewrote the body. Not yet confirmed on production: whether the other features rewrite artifact bodies today; the module disables them as a precaution.

## Expected outcome

The Terraform module owns an `http_config_settings` rule scoped to the Artifact Pages hostname that disables the body-rewriting features, and delivered artifact and preview bytes equal the published objects without any dashboard setting.

## Acceptance criteria

- [ ] The module change (terraform-cloudflare-artifact-pages PR #1) is merged and applied to the verification zone, then production, after the Terraform tokens gain Config Rules Edit.
- [ ] With the zone-wide dashboard setting restored to its default, `guide/en/publishing.html` served from production hashes equal to the Git blob and contains no `__cf_email__` or `/cdn-cgi/` script.
- [ ] A raw preview HTML object on production also hashes equal to its published bytes.
- [ ] `docs/specification.md` states the unchanged-delivery contract (done in the linked docs PR).
