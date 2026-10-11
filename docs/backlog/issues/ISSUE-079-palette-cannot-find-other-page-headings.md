# The command palette cannot find headings of other pages

- Status: Open
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

## Acceptance criteria

- [ ] A plain query that matches a heading of another page lists it, labeled "Page > Heading", below page matches so page-title results keep priority (ranking rule recorded in the issue).
- [ ] Selecting it opens the page at the heading (reusing the heading-jump path used for the open page).
- [ ] `#` mode can search all pages' headings, with the open page's headings listed first; the open-page-only wording in the footer hints and the specification is updated.
- [ ] No extra network request: the data is already loaded with the site index.
- [ ] Unit tests in `scripts/palette-sections.test.mjs` cover other-page headings, duplicate headings across pages, and the empty states; an e2e case opens another page's heading.
