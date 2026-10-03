# DOC-07 — Guide: access and trust

- Status: In progress
- Site: `guide`
- Page: `ja/access-and-trust.html`, `en/access-and-trust.html`
- Audience: Admins and teams deciding whether and what to publish
- Depends on: DOC-02

## Purpose

State what adopters must know before publishing: HTML is executable and must come from trusted sources, Markdown is sanitized, and viewer access control is configured at the delivery edge, not in the product.

## Scope

- Practical guidance: what to publish, what not to, and where to put access control (VPN, identity-aware proxy, provider policy).
- Link to DOC-12 for the reasoning.

## Out of scope

- CSP and origin mechanics (DOC-12).

## Primary sources

- [Specification §7 Markdown trust boundary, §18 viewer access](../../specification.md), [TD1](../technical-design/TD1-site-viewer-access.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)

## Acceptance criteria

- [x] `ja/access-and-trust.html` and `en/access-and-trust.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Draft (2026-10-02, awaiting owner review)

Sections: two summary panes (trust / access), HTML runs as published (SVG: one origin shared by the app, an HTML page, and other sites' files), Markdown is cleaned (HTML vs Markdown table), what to publish and what not to (checklists), who can read (SVG: edge access control in front of app routes, `/_indexes/*`, `/_artifacts/*`, `/_previews/*`; registry, hidden lists, and unguessable URLs are not access control; mechanisms and scope), taking content down, and a link to `/architecture/<lang>/trust-model.html` (`target="_top"`; 404 until DOC-12 is published). Pager: Configuration ←.

Sources checked: spec §7 (iframe without sandbox, CSP with `https:`, Markdown trust boundary), §16 (unregister cache), §18, §19 preview trust model; TD1; TD3. Release-independent.

Checked with Playwright (`guide-check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; tables, code, and SVG figures scroll inside their frames. All in-site links return 200; anchors used by cross-links exist. In the reader, in-site links and the pager route to logical `/guide/...` URLs, `target="_top"` architecture links replace the app (no nested app), and page text search for `retention` finds the new Configuration and Publishing pages. `npm run docs:check-assets` passes; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Review fixes (2026-10-02, awaiting owner review)

- Taking content down now covers previews: a preview revision containing the file is not changed by a new publish; its entry may leave the preview list, but its direct URL works until the provider retention rule removes it (spec §19: catalog cleanup removes references, not completed preview bytes). Only `registry unregister` deletes previews at once; a leaked secret in a preview should be assumed readable until then. Links to `publishing.html#previews`.
- Both SVG figures now use the architecture site's treatment: a figure head, a frame that scrolls sideways (focusable only when scrollable, faded edge while more is hidden), a "Scroll sideways to see the whole diagram" hint shown only when the frame overflows, and a "diagram as text" `<details>`. The shared CSS/JS were generalized minimally (`.figure-frame`/`.figure` added to the existing `.fig-frame`/`.fig` selectors); at 400 px both figures report scrollable with the hint visible, at 1280 px neither.
- Terms aligned with the architecture site: en figure says "site registry and indexes" for `/_indexes/*`; ja uses インデックス; the WHY callout label is 理由 in ja.
- Checked with Playwright (`guidefix/check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; all 50 distinct links return 200, anchors exist, and every root-absolute cross-site link uses `target="_top"` and resolves to a published architecture page. `npm run docs:sync-assets` and `npm run docs:check-assets` pass; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Second review fixes (2026-10-03, awaiting owner review)

- Heading outline: the two summary cards sit in a `<section>` labelled by a visually hidden H2 (要点 / Summary), so H1 → H2 → H3 no longer skips a level.
- ja: サイトの一覧とインデックス → サイトの登録情報とインデックス in the figure, its `<desc>`, and the text version.
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
