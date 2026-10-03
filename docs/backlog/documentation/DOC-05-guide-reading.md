# DOC-05 — Guide: reading

- Status: In progress
- Site: `guide`
- Page: `ja/reading.html`, `en/reading.html`
- Audience: Readers of published sites
- Depends on: DOC-02

## Purpose

Describe the reader experience: stable URLs, site home, sidebar, finding by name with ⌘K / Ctrl K, page text search with ⌘⇧F, `@` site switching, `#` headings, `>` commands, pins and recent reads.

## Scope

- URL shape and sharing; HTML vs Markdown rendering at the reader's level.
- Command palette modes and its blank state (pinned and recently read documents); sidebar page text search (IMP-42) and the palette hand-off.
- Theme and narrow-screen behavior.

## Out of scope

- Implementation of search scoring and index loading.

## Primary sources

- [Specification §4 routing, §7 viewer, §8 browser UX](../../specification.md)
- `web/src/components/CommandPalette.tsx`, `SiteHome.tsx`, `Sidebar.tsx`, `PageTextSearch.tsx`

## Acceptance criteria

- [x] `ja/reading.html` and `en/reading.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-01, awaiting owner review)

- Facts checked against specification §4, §7, §8 and the app: palette commands and shortcuts (`ArtifactWorkspace.tsx`), scopes and prefixes (`CommandPalette.tsx`), recent reads limit of 20 per site (`recent-reads.ts`), Recently updated from 7 artifacts (`navigation-sections.ts`).
- The index records the page titles and all eight headings; the reader's Contents panel lists them.
- In the local reader: the sample palette lists `Guide` and the illustrative site on `@`; its tree shows `en` and `ja` with the current page selected; previous/next links move between the overview and this page.
- `ja` and `en` render in light and dark, and at 400px without page-level horizontal scrolling (tables scroll inside their frame). No page errors.
- The overview page now links to this page as Next, and its "how it works" heading has an id so it appears in Contents.

## Revision for page text search (2026-10-02, awaiting owner review)

- The palette tabs paragraph was replaced: the search section now has "find by name" (⌘K, prefixes, blank palette lists pins and recent reads) and "search page text" (sidebar field, ⌘⇧F, Enter-only, AND of space-separated words, substring match, path order, highlight and scroll on open, `?q=` sharing, Esc/×, palette hand-off with ⌘↵, availability note). The keyboard table gained ⌘⇧F and ⌘↵; Recently updated is described on the home page only.
- The screen mock shows the page text search field. The shared demo script no longer draws palette tabs, shows the sidebar field as a non-interactive label, and uses the "Jump to a page…" wording on the overview page's site-home mock (`what-is-git-artifact-pages.html`, label-only change).
- The `guide` site is now published with `--fulltext`, so the reader's own Guide site offers page text search.
- Checked in the local reader and with Playwright: ja/en reading and overview pages at 400 px and 1280 px in light and dark have no horizontal overflow, no page errors, and no remaining "Filter navigation" text or palette tabs. A search for ハイライト in the reader finds this page and highlights the match.

## Navigation update (2026-10-02)

- Pager now continues to Publishing; the page text search note links `publishing.html#page-text-search`; the HTML/Markdown section links Access and trust. The screen mock's Browse tree lists the five guide pages per language (title order, as `web/src/domain/tree.ts` sorts). The shared demo's guide page list includes the three new pages.
- Checked with Playwright (`guide-check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; tables, code, and SVG figures scroll inside their frames. All in-site links return 200; anchors used by cross-links exist. In the reader, in-site links and the pager route to logical `/guide/...` URLs, `target="_top"` architecture links replace the app (no nested app), and page text search for `retention` finds the new Configuration and Publishing pages. `npm run docs:check-assets` passes; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).

## Review fixes (2026-10-02, awaiting owner review)

- ja: "日本語は語の途中でも一致します" replaced with the language-neutral "語の途中にある文字列でも一致します。"; the AND rule now reads "スペースで区切って複数の語を入れると、すべての語を含む文書だけが見つかります。"; half-width spaces removed from the meta description.
- Checked with Playwright (`guidefix/check.mjs`): all five guide pages in ja/en, light/dark, 400 px and 1280 px have no page-level horizontal overflow and no page or console errors; all 50 distinct links return 200, anchors exist, and every root-absolute cross-site link uses `target="_top"` and resolves to a published architecture page. `npm run docs:sync-assets` and `npm run docs:check-assets` pass; published with `site publish --site guide --config artifact-pages.yaml --fulltext` (dry-run first).
