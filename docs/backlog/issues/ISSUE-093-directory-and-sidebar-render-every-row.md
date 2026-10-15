# Directory pages and the sidebar tree render every row

- Status: Open
- Priority: P2
- Area: Directory page / sidebar
- Implementer: Claude
- Source: public-launch review 2026-10-13, finding R3

## Problem

A folder without a README renders one DOM row per page, with no cap, paging or virtualization, and the site root uses the same page. The sidebar tree also renders every row of an expanded branch and of broad filter results. On a large site this mounts thousands of rows on the main reading surfaces. The earlier SiteHome virtualization benchmark does not cover the current screens.

This is required before the launch advertises large-site support. For a small-scale launch the supported site size may be documented instead; that decision belongs to the launch scope (see [T25](../verification/T25-web-first-load-and-search-at-scale.md)).

## Evidence and reproduction

1. `web/src/components/DirectoryPage.tsx:135` maps all `pages`. A README-backed folder uses a compact list that starts at 10 rows and expands with "Show all N items" (line 106, which then renders everything).
2. `web/src/components/ArtifactTree.tsx` renders every entry of `files` (line 200) and of the recent and filter lists (lines 207 and 210).
3. Server-side render of the real `DirectoryPage` with 5,000 pages: without a README 5,000 rows and 2,889,384 bytes of HTML; with a README 10 rows (public-launch review 2026-10-13, workspace-local report). This counts mounted rows structurally; it is not a browser timing.

4. Rechecked at `86841bb1` on 2026-10-15 in the built reader: a synthetic 5,000-page flat site mounted 5,000 directory rows and 5,000 sidebar links, with 90,127 DOM elements overall. The same component SSR still produced 5,000 rows / 2,889,384 bytes without a README and 10 compact rows with one. This confirms structure, not a latency percentile or supported-size limit. Supplementary workspace evidence: `reviews/2026-10-15-project/large-dom.json` and `reproductions.json`.

## Expected outcome

The number of rendered rows in a directory page and in the sidebar is bounded regardless of folder size, and every page stays reachable.

## Acceptance criteria

- [ ] Directory pages bound the rendered row count (paging or virtualization) with and without a README, including after "Show all".
- [ ] The sidebar tree bounds rendered rows for expanded branches and filter results.
- [ ] The last page or row is reachable, and the tree filter, keyboard navigation and current-location highlight keep working.
- [ ] A regression test with 5,000 rows asserts the bounded count in both components.
