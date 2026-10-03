# DOC-06 — Guide: configuration

- Status: In progress
- Site: `guide`
- Page: `ja/configuration.html`, `en/configuration.html`
- Audience: Admins maintaining a deployment
- Depends on: DOC-03

## Purpose

Document the deployment config: file location and precedence, `schemaVersion`, `provider` blocks, the `sites` mapping, layering, and remote `github://` locators.

## Scope

- Config selection precedence and the default filename.
- Provider blocks for `local`, AWS, and Cloudflare at the level needed to choose and fill them; credentials never go in YAML.
- `sites` as the complete desired set and what removing a site does.

## Out of scope

- Terraform and account provisioning details beyond linking the operator guides.

## Primary sources

- [Specification §22](../../specification.md), [T10](../technical-design/T10-config-location.md), [T12](../technical-design/T12-cloudflare-production-mapping.md)
- [Cloudflare deployment](../../guides/cloudflare-deployment.md), [Local edge object storage](../../guides/local-edge-object-storage.md)

## Acceptance criteria

- [x] `ja/configuration.html` and `en/configuration.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- Wait for the default-config filename change to settle before drafting.

## Dependency on the release shape

This page refers to how components are obtained and pinned. Draft it after the release-shape decision recorded in [DOC-03](DOC-03-guide-getting-started.md#blocker-2026-10-01).

## Draft (2026-10-02, awaiting owner review)

Sections: the file at a glance (annotated YAML, top-level key table, strict parsing), which file is used (four-level precedence), layers, remote `github://` config, delivery targets (`local`, `aws`, `cloudflare` key tables; `gcp-local` noted as an emulator profile), credentials (AWS chain; Cloudflare per-command table; registry-reader option), `sites` (field rules, complete-set warning, `sites: {}`), and applying changes (`registry register` / `unregister`, locks). Pager: Publishing ← → Access and trust.

Sources checked: spec §11, §22; T10; T11; `cli/internal/config/config.go` (provider names, required keys, 32-hex Cloudflare IDs, HTTPS `publicBaseURL`, config lookup in the current working directory); `cli/internal/registry/registry.go` (optional `description`); `cli/internal/publisher/aws.go` (`distributionId` used only for CloudFront invalidation); `docs/guides/cloudflare-deployment.md`.

### Parts that depend on the release decision (DOC-03)

- `app deploy` and installing the reader app are mentioned only in a closing note pointing to Getting started (not yet published, not linked).
- The page itself is release-independent.

### Discrepancies found in sources (for the owner)

- `description` on a site entry is accepted by the CLI and shown in the site picker/palette, but spec §11 says entries contain exactly `name`, `repository`, `sourcePath`. The page documents `description` as optional.
- `docs/guides/cloudflare-deployment.md`'s credential table says `site publish` does not need `CF_API_TOKEN`, while its later text and spec §22 say the token is needed for a non-empty cache purge. The page follows spec §22.
- Spec says "repository-local `artifact-pages.yaml`"; the code reads it from the current working directory. The page says "the current directory".

Checked with Playwright (`guide-check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; tables, code, and SVG figures scroll inside their frames. All in-site links return 200; anchors used by cross-links exist. In the reader, in-site links and the pager route to logical `/guide/...` URLs, `target="_top"` architecture links replace the app (no nested app), and page text search for `retention` finds the new Configuration and Publishing pages. `npm run docs:check-assets` passes; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Review fixes (2026-10-02, awaiting owner review)

- Credentials: the publishing job's scope now includes the cache-retry record `_control/site-cache/<site>.json` (read, write, delete) and the CDN cache refresh (CloudFront invalidation on AWS, zone cache purge on Cloudflare), per spec §5 and `site_cache.go`.
- Cloudflare API token column rewritten from the source: `site publish`, `registry register|unregister`, and `app deploy` call `validateInvalidation` before writing whenever the run has invalidation paths (`site_publish.go`, `registry_apply.go`, `publish.go`; `cloudflare.go` `ValidateInvalidation`), so the token is needed for any run that changes content (or retries an unfinished purge) and never for dry runs or no-op runs. `preview publish` never requests invalidation, so it is now its own row with "Not needed". This also resolves the earlier `cloudflare-deployment.md` discrepancy in favor of spec §22 and the code.
- ja: 索引 → インデックス; half-width spaces removed from the meta description and aria-labels.
- Checked with Playwright (`guidefix/check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; all 50 distinct links return 200, anchors exist, and every root-absolute cross-site link uses `target="_top"` and resolves to a published architecture page. `npm run docs:sync-assets` and `npm run docs:check-assets` pass; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Second review fixes (2026-10-03, awaiting owner review)

- Release wording (owner direction): the closing `app deploy` note now says available versions are listed on GitHub Releases (single link); no hard-coded version or "not published" caveat. Release details are expected to change; the release-dependent note above is superseded.
- ja: the `sites` mapping is called サイトの定義 (not サイトの一覧, which is reserved for the site picker).
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
