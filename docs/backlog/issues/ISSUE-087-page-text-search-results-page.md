# Page text search needs a results page in the reading area

- Status: In progress
- Assignee: Claude
- Priority: P2
- Area: Page text search (`web/`: sidebar, command palette, routing, reader); specification

## Problem

Page text search results live in the sidebar, which is too narrow to show more than a title and a one-word match reason, and the sidebar field commits a query only on Enter. Readers cannot see how many pages match per folder, cannot share or revisit a result list by URL as a page of its own, and cannot step through the matches inside the page they opened.

Owner feedback of 2026-10-11 on the live sites asked for a wider place for results. [TD20](../technical-design/TD20-search-results-page-and-snippet-packs.md) decided the direction: a results page in the main area, with the sidebar reduced to a title and path filter. This issue is TD20 slice 1: everything that works on today's v1 search data, without snippets or heading anchors (those come with the format slice and [ISSUE-085](ISSUE-085-page-text-search-snippets.md)).

## Evidence and reproduction

1. Open a site that publishes page text search and search for a word in the sidebar field.
2. Results replace Pinned and Browse in the sidebar, one row per page, with a "Search only in <folder>/" chip as the only way to narrow them.
3. Open a result: the page highlights the terms and scrolls to the first one, but there is no way to move to the next match.

## Expected outcome

- `/<site>/_search?q=…&in=<folder>` shows the results in the reading area: a search field that updates as the reader types, a count, folder facets with per-folder counts, and ranked results (the [ISSUE-077](ISSUE-077-fulltext-results-unranked.md) ranking) with title and path.
- The sidebar field filters titles and paths only and ends with a row that opens the results page; the command palette gets the same entry.
- An opened result highlights its matches and offers a match navigator ("q  2 / 5  ↑ ↓ ×").

## Acceptance criteria

- [x] Design: [TD20](../technical-design/TD20-search-results-page-and-snippet-packs.md) (direction accepted 2026-10-11).
- [x] `_search` is a reserved first segment next to `_previews` in the specification; the route survives reload, Back/forward, and a shared URL, and the document title names the query.
- [x] The results page shows count, folder facets with counts for the current query, ranked results, paging, and no-match, loading and error states; narrow screens scroll the facets horizontally without page-level overflow.
- [x] The sidebar search is a title and path filter that ends with a "Search full text" row; the palette has the same entry; the sidebar no longer lists full-text results.
- [x] Opening a result highlights and scrolls to the first match as before, and a match navigator steps through the matches of Markdown and HTML pages (buttons, Enter and Shift+Enter, Esc closes and returns focus to the page).
- [x] The search field is labelled; results are a list of links; facets expose `aria-pressed`; counts are announced through a status region; focus moves into the page on route entry.
- [x] The specification's page text search paragraph describes the new behaviour.
- [x] Unit tests (routing, facets, navigator), Playwright e2e and production Storybook stories cover the page.

## Follow-ups

- Indexer enforcement of reserved first segments (`_previews`, `_search`) is a separate Codex item; until it lands a page whose path starts with `_search/` is unreachable, as `_previews/` is today.
- Snippets, heading anchors and body-hit ordering: [ISSUE-085](ISSUE-085-page-text-search-snippets.md) after the format slice.
