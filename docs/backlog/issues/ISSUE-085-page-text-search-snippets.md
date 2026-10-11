# Page text search results show no match snippet

- Status: Blocked
- Priority: P3
- Area: Page text search results (`web/src/components/PageTextSearch.tsx`); search format (`cli/internal/fulltext`, Codex-owned)

## Blocker

Blocked on [IMP-77](../implementation/IMP-77-fulltext-section-table-and-text-packs.md)'s format contract and golden fixtures (Codex). [TD20](../technical-design/TD20-search-results-page-and-snippet-packs.md) direction is accepted (2026-10-11) and the results page shipped in ISSUE-087; once the contract merges, the reader side (snippets, headings, body-hit ordering) proceeds in parallel with the Go writer. Package WS1 in [workstreams](../workstreams.md#current-work-packages-2026-10-11).

## Problem

Split from [ISSUE-077](ISSUE-077-fulltext-results-unranked.md). Ranked results now say whether a page matched in its title, a heading or only its text, but a "Text" match still gives no excerpt. The reader cannot see the matching sentence before opening the page, and body-only hits cannot be ordered by how often or where the terms occur.

## Evidence and reproduction

1. Search the guide site for a term that appears only in body text.
2. Results show "Text" as the match reason, with no excerpt.

The search projection stores tokens and postings, not text, frequencies or positions (`docs/architecture/fulltext-search.md`, "Search semantics" and the reader-side ranking note added by ISSUE-077). Snippets therefore need either a search format change or a client fetch of each result page.

## Expected outcome

Each "Text" result shows a short excerpt around the first match, and body-only hits can be ordered by relevance.

## Acceptance criteria

- [ ] A design note in `docs/architecture/fulltext-search.md` chooses between a format change (stored excerpts or term positions, versioned per TD2 and owned by the CLI side) and a bounded client fetch of result pages, with size and latency measurements.
- [ ] If the format changes, the CLI and web slices are split and sequenced through `STATUS.md`.
- [ ] Results show a highlighted excerpt for text matches without regressing the ISSUE-077 ranking, the fallback above the ranking threshold, or keyboard navigation.
- [ ] Specification updated.
