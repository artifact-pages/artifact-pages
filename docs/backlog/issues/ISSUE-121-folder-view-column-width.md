# The folder view's column is narrow and looks off-centre in a wide window

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Web / directory page

## Problem

A folder's page (header, "In this folder" list, the `index.html` row and the folder's index body) sits in a column that is at most 860 px wide. In a wide window it is centred in the main area but covers little of it, so it reads as a narrow strip well to the right of the visible centre. The docs pages render in a wider column (`min(1180px, 100%)`, side padding `clamp(20px, 4vw, 56px)`), which the owner prefers.

## Evidence and reproduction

1. Owner report, 2026-10-23 (production reader, site `ja`, folder `01-features/`, screenshot 1935 px wide, sidebar open): header, list and index row at x 1063 to 1810.
2. Reproduced at a 2560 px viewport with the sidebar open: the column is the 860 px `.directory-page` centred in the main area (x 313 to 2560), header x 1063 to 1811. At 1935 px it is x 694 to 1554. Nothing is shifted; the column is centred in the main area and 860 px wide, so in a screenshot cropped to 1935 px it reads as off-centre. Confirmed with `getBoundingClientRect` on `.stage`, `.directory-page` and `.directory-header`.

## Expected outcome

In a folder view the header, the child list, the `index.html` row and the folder's index body share one column, centred in the main area, at most 1180 px wide with side padding `clamp(20px, 4vw, 56px)`. Below that width it fills the main area. A folder without an index page uses the same column. The site root, document pages, previews, sidebar and mobile layout do not change.

## Acceptance criteria

- [x] At 1935 px (sidebar open) and 1280 px, the folder header, list, index row and index body share the same left and right edges, and the column is centred in the main area with a width of at most 1180 px.
- [x] A folder without an index page uses the same column.
- [x] The site root's directory page keeps its previous column; 390 px and 768 px layouts, light and dark, are unchanged.

## Resolution

Fixed in #199 (6c1669af), released as `web/v0.4.5` and deployed to production by App deploy run 40057371194 on 2026-10-24.

Production check on 2026-10-24 (`https://artifact-pages.dev/ja/05-reference`, sidebar open, Playwright `getBoundingClientRect`):

| Viewport | Main area | Folder column | Header |
| --- | --- | --- | --- |
| 2560 | 313 to 2560 | 846.5 to 2026.5 (1180 px, centred) | — |
| 1935 | 313 to 1935 | 534 to 1714 (1180 px, centred) | 590 to 1658 |
| 1280 | 270 to 1280 | 270 to 1280 | 321 to 1229 |
| 768, dark | 49 to 768 | 49 to 768 | 80 to 737 |
| 390 | 1 to 390 | 1 to 390 | 21 to 370 |

No horizontal scroll at any width. The site root (`/ja`, 1935 px) keeps its 860 px column (694 to 1554). The folder without an index page is covered by the e2e geometry test added in #199.
