# DOC-12 — Architecture: trust model

- Status: In progress
- Site: `architecture`
- Page: `ja/trust-model.html`, `en/trust-model.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-08

## Purpose

Explain the trust model behind DOC-07: HTML rendered as trusted same-origin content in an iframe, sanitized Markdown, per-site CSP, and why viewer identity is out of scope.

## Scope

- The threat model the product accepts and what it does not defend against.
- Per-site CSP and its consequences (for example, no cross-site shared assets).

## Out of scope

- Operational access setup (DOC-07).

## Primary sources

- [Specification §7, §18, §21](../../specification.md), [TD1](../technical-design/TD1-site-viewer-access.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)

## Acceptance criteria

- [x] `ja/trust-model.html` and `en/trust-model.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-02, drafted in the batch with DOC-08–DOC-13; awaiting independent and owner review)

- Published locally: `./artifact-pages site publish --site architecture --config artifact-pages.yaml --fulltext --dry-run` (146 planned creates), then the same command without `--dry-run` (`PUBLISHED`). `meta.json` advertises `fullTextUrl`.
- Playwright (throwaway script outside the repo) opened every architecture page in `ja` and `en` directly under `/_artifacts/architecture/…` at 400 px and 1280 px in light and dark: no page-level horizontal overflow, no page or console errors, one localized H1 and `<title>` per page, `lang` set, the site page list marks the current page, every same-origin link (including the language switch, previous/next, cross-links, and links to `/guide/<lang>/…`) returns 200, and every in-site `#fragment` exists. Wide diagrams scroll inside their own frame and only then become keyboard-focusable.
- In the reader at http://localhost:4179: the site picker lists Architecture; Next moved the app to `/architecture/en/storage-layout.html`; the language switch moved it to `/architecture/ja/storage-layout.html`; a guide link moved it to `/guide/en/access-and-trust.html`; `?q=immutable leaf` listed 3 pages and highlighted the terms in the open page; at 400 px the framed page has no horizontal overflow.
- Facts checked against specification §7, §18, §19 (preview rendering trust model), §21, TD1, TD3, the artifact CSP map in `docker/nginx/default.conf`, and T4/T6/T15. The page states that the `https:` source also matches other sites' paths once served over HTTPS, so the per-site CSP is not a cross-site wall in production (spec §7); per-site asset copies are explained on that basis.
- Review fixes (2026-10-02): Japanese terms aligned with the guide (認証情報, インデックス, 一覧 for the preview catalog) and no half-width spaces around ASCII terms in Japanese text; architecture→guide links are root-absolute logical routes with `target="_top"`. Republished with `site publish --site architecture --config artifact-pages.yaml --fulltext` (dry-run, then publish: 145 files synced, 101 stale removed, 246 revalidation paths). Playwright re-check of all 12 pages at 400/1280 px in light and dark: no overflow, no console/page errors, all 20 same-origin links 200, all fragments present; reader navigation, guide link, and `?q=immutable leaf` (3 pages) re-verified.
- Publisher credential scope now includes the exact `_control/site-cache/<site>.json` retry record (read/write/delete) and CDN invalidation (CloudFront `CreateInvalidation` or a Cloudflare zone cache-purge token), per spec §5 and T15 October 2; the AWS reference withholds preview-history deletion. Revision-scoped preview CSP (October 1) and the runtime HTTP fetch refused by enforced CSP on live Guide (October 2) moved to sampled; open items are the full resource-type/browser matrix, purge-token isolation, OIDC, and AWS. The diagram's publish label no longer crosses the dashed gate border.

## Second review fixes (2026-10-03, awaiting owner review)

- en: removed the unused `<marker id="tm-w">`. ja: レジストリ → サイトの登録情報 (prose and figure); page list label → プレビューの仕組み.
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
