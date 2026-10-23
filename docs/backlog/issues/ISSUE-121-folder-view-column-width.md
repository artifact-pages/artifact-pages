# The folder view's column is narrow and looks off-centre in a wide window

- Status: In progress
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

- [ ] At 1935 px (sidebar open) and 1280 px, the folder header, list, index row and index body share the same left and right edges, and the column is centred in the main area with a width of at most 1180 px.
- [ ] A folder without an index page uses the same column.
- [ ] The site root's directory page keeps its previous column; 390 px and 768 px layouts, light and dark, are unchanged.
