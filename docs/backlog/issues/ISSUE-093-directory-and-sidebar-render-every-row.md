# Directory pages and the sidebar tree render every row

- Status: Done
- Assignee: Claude
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

- [x] Directory pages bound the rendered row count (paging or virtualization) with and without a README, including after "Show all".
- [x] The sidebar tree bounds rendered rows for expanded branches and filter results.
- [x] The last page or row is reachable, and the tree filter, keyboard navigation and current-location highlight keep working.
- [x] A regression test with 5,000 rows asserts the bounded count in both components.

## Verification

- `npm run build` passes.
- `npm run test:web-unit` passes, including `web/src/domain/row-window.test.mjs` (window bounds for 5,000 rows, active row beyond the limit, hidden counts).
- e2e (compose project `claude-issue-093`, port 4393, `PLAYWRIGHT_BASE_URL` subset recipe from ISSUE-072) in `web/e2e/local-serving.spec.ts`, `directory pages`: a 5,000-page folder mounts at most 100 rows and the pager reaches the 5,000th row while the sidebar branch mounts 100 rows plus the overflow link; opening page 4,321 keeps its row (101 rows); a filter matching 2,000 pages mounts at most 101 rows; a README folder with 5,000 children shows 10 rows, then at most 100 plus the pager after "Show all".
- Subset `-g "directory|tree|sidebar|folder"`: 41 passed.
- Storybook: `DirectoryPage.stories.tsx` has 5,000-row stories (no README, README).
- Review follow-up: the tree view also has a tree-wide budget of 400 rows (`TREE_TOTAL_ROW_LIMIT`; directory and artifact rows in depth-first order). The active page/folder and its ancestors are pinned and not counted. `row-window.test.mjs` simulates 100 folders of 50 pages; e2e `a filter matching 60 folders of 60 pages stays within the tree-wide row budget` asserts at most 400 rows, at most 61 overflow rows and the note. Build, `test:web-unit` (all suites pass) and the `directory|tree|sidebar|folder|5,000|row budget` e2e subset (42 passed) rerun.
