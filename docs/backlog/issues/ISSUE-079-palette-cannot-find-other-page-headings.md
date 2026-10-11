# The command palette cannot find headings of other pages

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Command palette (`web/src/domain/palette-sections.ts`)

## Problem

A reader who remembers a section name but not the page title cannot find it from the palette. Headings are searchable only for the page that is already open, although the index carries the headings of every page.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, confirmed in code.

1. Open the Guide site home, open the palette and type `cloudflare`. No page matches by title or path; the only option is "Search page text for "cloudflare"", which needs another Enter.
2. The heading "Start with Cloudflare" exists on Getting started and is in that artifact's `toc` in `index.json`.
3. The `#` mode and the fallback section look only at the open artifact: `buildHeadingEntries(currentArtifact, ...)` iterates `currentArtifact?.toc` (`palette-sections.ts:375-385`), used by `#` mode (`:201-204`) and by "Headings in this page" (`:239-243`). When no artifact is open, `#` reports "Open an artifact first to search its headings." (`:135-139`).

This is the documented contract (`docs/specification.md:463`: `#` searches headings in the open artifact), so changing it is a product decision, not a regression. Only headings that have an `id` are in the index `toc`; headings without ids are a content matter for the docs repository and are not filed here.

## Expected outcome

A heading of any page in the site can be found and opened from the palette, with the page it belongs to visible.

## Owner decision (2026-10-11)

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-079 stories: in the normal palette, variant A, a separate "Headings in other pages" section below the page results so pages keep priority. In `#` mode, headings of all pages are searched with the open page's headings first (variant C behavior).

## Acceptance criteria

- [x] A plain query that matches a heading of another page lists it, as a row "Heading — Page title · folder", below page matches so page-title results keep priority (ranking rule recorded in the issue).
- [x] Scope added from [ISSUE-075](ISSUE-075-directory-routes-have-no-page.md): the palette also lists a "Folders" group below page matches, with page counts; selecting a folder navigates to its route `/<site>/<folder path>`.
- [x] Selecting it opens the page at the heading (reusing the heading-jump path used for the open page).
- [x] `#` mode can search all pages' headings, with the open page's headings listed first; the open-page-only wording in the footer hints and the specification is updated.
- [x] No extra network request: the data is already loaded with the site index.
- [x] Unit tests in `scripts/palette-sections.test.mjs` cover other-page headings, duplicate headings across pages, and the empty states; an e2e case opens another page's heading.

## Resolution

Implemented in `web/src/domain/palette-sections.ts`, `palette-headings.ts` and `palette-folders.ts`. Rows read "Heading" with "Page title · folder" below. Ranking and dedupe rules are in `docs/specification.md` (Search): pages first, then the Page text row (it stays the default Enter target when no page name matches, per IMP-42), then Folders (4 rows), Headings in this page (fallback only) and Headings in other pages (6 rows, 3 per page; held back until the query has two characters); a page's own title-level headings are skipped when the page is already listed; identical text on one page is listed once; a one-page folder whose page is already listed is hidden unless its own name matched. `#` searches all pages with the open page first (20 other rows, 5 per page). Heading text is prepared in the background when the palette opens, rejected by character masks, and narrowed incrementally while the query grows. Covered by `scripts/palette-sections.test.mjs` and the palette cases in `web/e2e/local-serving.spec.ts`. Folder rows link with `artifactRouteHref` through the thin `folderRouteHref` wrapper in `palette-folders.ts`.
