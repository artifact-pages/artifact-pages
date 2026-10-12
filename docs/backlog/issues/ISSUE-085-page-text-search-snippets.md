# Page text search results show no match snippet

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Page text search results (`web/src/components/PageTextSearch.tsx`); search format (`cli/internal/fulltext`, Codex-owned)

## Status note

The format contract merged in #106 and the writer is [IMP-77](../implementation/IMP-77-fulltext-section-table-and-text-packs.md) (Codex); this item is the reader side.

## Problem

Split from [ISSUE-077](ISSUE-077-fulltext-results-unranked.md). Ranked results now say whether a page matched in its title, a heading or only its text, but a "Text" match still gives no excerpt. The reader cannot see the matching sentence before opening the page, and body-only hits cannot be ordered by how often or where the terms occur.

## Evidence and reproduction

1. Search the guide site for a term that appears only in body text.
2. Results show "Text" as the match reason, with no excerpt.

The search projection stores tokens and postings, not text, frequencies or positions (`docs/architecture/fulltext-search.md`, "Search semantics" and the reader-side ranking note added by ISSUE-077). Snippets therefore need either a search format change or a client fetch of each result page.

## Expected outcome

Each text result shows a short excerpt around the first match, linking to its section. Body-only hits are not reordered by snippets (contract, Reader procedure step 8, owner 2026-10-12).

## Acceptance criteria

- [x] The design note choosing the format change is met by the contract in `docs/architecture/fulltext-search.md` (#106); the CLI and web slices are split (IMP-77 and this item).
- [x] Results show a highlighted excerpt for text matches without reordering or regressing the ISSUE-077 ranking, the fallback above the ranking threshold, or keyboard navigation.
- [x] Specification updated.

## Production check (2026-10-12)

CLI v0.4.2 (with the IMP-77 writer, #116) republished `guide` and `architecture` on https://artifact-pages.dev (docs Publish run 38230281773: one section table and two text packs per site, no caps hit). With web 0.3.0 (#113), `/guide/_search?q=cache` shows four results, each with its section heading and a highlighted excerpt cut with "…", in the unchanged ISSUE-077 order; rows link to the section anchor. Done.
