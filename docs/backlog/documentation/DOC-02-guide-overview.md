# DOC-02 — Guide: overview page

- Status: In progress
- Site: `guide`
- Page: `ja/what-is-git-artifact-pages.html`, `en/what-is-git-artifact-pages.html`
- Audience: Everyone; first page a new visitor reads
- Depends on: DOC-01

## Purpose

Introduce what Git Artifact Pages is and walk through the four roles (deploy the app, register sites, publish from each repository, read) with the scroll-driven diagram, then show a team site's home page and the `@` site switch.

## Scope

- Hero, three promises, the four-step story with the growing diagram, and the example team site with the command palette.
- Point readers to the next guide pages and to the `architecture` site once those exist.

## Out of scope

- Detailed procedures (DOC-03, DOC-04) and configuration reference (DOC-06).

## Primary sources

- [Specification §1–§3, §8](../../specification.md), [§22 deployment configuration](../../specification.md)
- `artifact-pages app deploy|registry register|site publish --help`

## Acceptance criteria

- [x] `ja/what-is-git-artifact-pages.html` and `en/what-is-git-artifact-pages.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [x] The owner reviewed and approved the page.

## Verification (2026-10-01)

- Owner approved the page content on 2026-10-01; follow-up fixes: config name `artifact-pages.yaml` (the default-config rename is implemented), Japanese section and step labels, app-accurate sidebar tree in both mocks, the example site home shown before the palette opens, theme copied from the reader app before first paint, softer CI wording.
- Local reader with the app forced dark and the OS light: the page's `data-theme` is `dark` at DOMContentLoaded. The example palette is closed at 0.9s and open with six sites at 3.1s. No page errors.
- `ja` and `en` render at 1440px light and 400px dark without horizontal scrolling; `npm run docs:check-assets` passes; `site publish --site guide` synced.

## Notes

- Add previous/next links once DOC-03 exists.

## Revision for the reading experience (2026-10-02, awaiting owner review)

- New "What reading is like" section right after the promises: a compact feature grid with small app-style glyphs (stable URLs, ⌘K find by name, ⌘⇧F page text search with highlight and the availability note, `@` site switch, Contents/Details, pins and recent reads kept in the browser, HTML as published / Markdown rendered), linking to Reading for details.
- Promise 03 now says "find pages by name" (no longer implies one search); the "How it works" heading has a line linking to `/architecture/en|ja/overview.html` (`target="_top"`); a "Where to next" card row links Publishing, Configuration, Access and trust, and the Architecture overview; the footer links Access and trust.
- Re-checked for stale statements: no sidebar name filter, palette tabs, or sidebar Recently updated remain. Step 1 still says `app deploy --version x.y.z`; it is release-dependent (DOC-03 blocker). (Superseded by the review fixes below, which state that no release is published yet.)
- The Architecture links resolve to the SPA shell; the architecture pages themselves return 404 until DOC-08/DOC-12 are published.
- Checked with Playwright (`guide-check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; tables, code, and SVG figures scroll inside their frames. All in-site links return 200; anchors used by cross-links exist. In the reader, in-site links and the pager route to logical `/guide/...` URLs, `target="_top"` architecture links replace the app (no nested app), and page text search for `retention` finds the new Configuration and Publishing pages. `npm run docs:check-assets` passes; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Review fixes (2026-10-02, awaiting owner review)

- Step 1 no longer implies a published release: the command "downloads and verifies a web release of the app", and the note says `x.y.z` stands for a release version, no release is published yet, and Getting started (not yet published, not linked) will cover it.
- Step 4: ⌘K / Ctrl K "finds pages in the current site and headings in the open page" (ja: いまのサイトのページと、開いているページの見出し), matching the palette's `#` scope (`CommandPalette.tsx`).
- Site-home mock now follows the app (`navigation-sections.ts` minimum of 7, `SiteHome.tsx` lede and 6 most recent): the illustrative `checkout` site has 7 artifacts, the lede reads "7 published artifacts. Browse the latest work…", and Recently updated lists 6. The shared demo (`renderSite`) computes the count, singular/plural, lede, and heading the same way; switching with `@` to a site with fewer than 7 artifacts shows "Browse artifacts or jump to one by name." and a Browse tree instead of Recently updated (checked for `sre` in ja/en).
- ja terminology aligned with the architecture site: インデックス (not 索引); the architecture card and story link say アーキテクチャの全体像 (the page title) and describe アプリケーションプレーンとコンテンツプレーン. Half-width spaces around ASCII terms removed from the ja meta description.
- Checked with Playwright (`guidefix/check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; all 50 distinct links return 200, anchors exist, and every root-absolute cross-site link uses `target="_top"` and resolves to a published architecture page. `npm run docs:sync-assets` and `npm run docs:check-assets` pass; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Narrative and publishing animation (2026-10-02, awaiting owner review)

- Reframed around the owner's positioning ("Independent publishing, shared experience"): Git-managed artifacts → independently published per site → shared static projection → one reader app. New hero eyebrow/H1 (各リポジトリから公開し、ひとつの場所で読む。 / Publish from each repository. Read in one place.) and lead; meta description and the palette demo's page description (`site.js` `GUIDE_PAGES`) follow it. Promises are now Git is the source / Each site publishes on its own / One place to read. The reading section says every site is read with the same app and controls, and search stays within the open site. The story intro and step 3 state that the admin only provides the app and the registry, and that each repository publishes only its own site from its own CI without a central build or waiting for other sites. The architecture card text and the SVG `<desc>` follow the same framing.
- Scene 3 animation (shared `site.js` section 3a, `site.css`): when scene 3 starts, the repositories appear one at a time (checkout at 0.25 s, sre at 1.25 s, billing at 2.25 s). Each then publishes on its own period and phase (first at 3.3 / 5.0 / 6.9 s, every 6.1 / 7.7 / 9.3 s); a guard keeps any two publish starts at least 1.5 s apart. A publish shows a dot travelling up that repository's arrow and a brief glow of its `site publish` chip; on arrival only that site's card flips from 登録済み · 未公開 / Registered · not published to ✓ 公開済み / ✓ Published with a short card flash, and later cycles briefly show ✓ 更新を公開 / ✓ Update published. The scene-3 caption now says each repository publishes only its own site on its own timing and there is no central build. The sequence stops and resets when scene 3 is left, the panel is off-screen (IntersectionObserver), or the tab is hidden, and restarts from the beginning on return. `prefers-reduced-motion: reduce` never enables it (static final state: all three visible and published); no-JS shows the complete static diagram; the narrow per-step figures clone the SVG without live classes and stay static.
- Evidence (Playwright, `narr/anim.mjs`, 1280 px, sampled every ~40 ms for 13 s after scrolling to step 3, ja and en): appearance checkout ≈0.51 s, sre ≈1.50 s, billing ≈2.49 s after the scroll; publish starts checkout 3.55, sre 5.24, billing 7.13, checkout 9.65, sre 12.95 s; minimum gap between any two starts 1.67 s; status texts flip per site only after its own publish; ✓ Update published appears only on checkout's second cycle. Scene 4 shows all published with live classes cleared; returning to scene 3 restarts (all hidden at 150 ms, checkout and sre back by 1.75 s); scrolling to the top clears all live classes. Reduced motion: no `is-live`, all three visible and published, unchanged after 4 s. 400 px: the step-3 figure shows three published cards, no dots, and the new caption. Inside the reader at http://localhost:4179 the sequence runs in the iframe (checkout → sre → billing appear, then publish one at a time). Screenshots at 1.5/3.0/3.7/5.6/8.0 s, scene 4, reduced motion, and narrow figures were reviewed.
- Checked with Playwright (`narr/check.mjs`): this page and the architecture overview in ja/en, light/dark, 400/1280 px have no page-level overflow, one H1, and no console or page errors; all 40 distinct links resolve, anchors exist, cross-site links use `target="_top"`. `npm run docs:sync-assets` and `npm run docs:check-assets` pass; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first; synced 32 files, removed 25 stale files, the known `search/*.gz` churn).
- `web/src/stories/DocsSite.stories.tsx` still shows the old hero H1 as Storybook sample text; it is not part of the published site and was left unchanged.

## Second review fixes (2026-10-03, awaiting owner review)

- Release wording (owner direction): step 01 keeps `app deploy --version x.y.z`; the note says `x.y.z` stands for a release version and links once to GitHub Releases. No hard-coded version, no install mechanics, no "not released" caveat. Release details are expected to change.
- Diagram heading: サイト一覧 · 登録されたサイト → サイトの登録情報 · 登録されたサイト (サイトの一覧 is kept only for the site picker screen).
- Narrow step-3 figure (shared `site.js` 3b): replaced the 700-unit crop (which cropped billing at 400 px) with a dedicated static layout built from the same SVG's strings: three rows, repository card → arrow → registered-site card (✓ Published), the `site publish` chip and registry label on top, the note below. viewBox 380 wide; at 400 px it renders 338 px wide with no sideways scrolling. `.step-figure-frame` now gets `tabindex="0"` only while it is scrollable (steps 2 at 400 px), like `.fig-frame`.
- Scene-3 re-entry flicker (shared `site.js` 3a, `site.css`): returning from scene 4 starts the loop warm — repositories stay in, all three cards stay published, the publish loops restart (first publishes 2 s earlier) — with transitions disabled for that frame (`.is-resetting`). Entering from scene 2 still replays the staggered entry. Sampled every ~10 ms for 1.2 s after returning from scene 4 (ja/en): minimum repository opacity 1, no "not published" status, no dashed card. Order and spacing unchanged: appear 0.51/1.49/2.49 s, publishes checkout 3.55, sre 5.24, billing 7.14, checkout 9.66, sre 12.93 s, minimum gap 1.67 s; reduced motion stays static and unchanged after 4 s.
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.

## Third review fixes (2026-10-03)

- Step 01 now shows `app deploy --dry-run` / `app deploy` without `--version`: the current CLI has no such option and deploys the web release matching its own version (spec §22 area, `app deploy --help`). The note says so and links GitHub Releases once. Supersedes the step 01 notes above.
- The lead's bold sentence uses です/ます like the rest of the paragraph. Narrow step figures expose a `role="group"` name from their caption when scrollable.
