# The indexer does not reject documents under reserved first path segments

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Indexer and preview builder (`cli/`); specification

## Problem

The web reader routes `/<site>/_previews...` and `/<site>/_search` itself. Nothing in the CLI stopped a site from publishing a document whose site-relative path starts with one of those segments, so the page (or its directory page, [ISSUE-075](ISSUE-075-directory-pages.md)) was silently unreachable.

## Evidence and reproduction

1. Put `_search/notes.md` in a site source directory and publish it.
2. The build succeeds; `/<site>/_search/notes` resolves to the search route, not the page.

## Expected outcome

A build whose documents start with a reserved first segment fails with an error naming each offending file and the reserved names, in both site publish and preview builds, so the problem surfaces in pull-request previews first.

## Acceptance criteria

- [x] The indexer rejects any document whose first site-relative path segment is exactly `_previews` or `_search` (case-sensitive) and lists every offending file; `docs/_search.md`, `_searchable/x.md` and `a/_previews/b.md` are accepted.
- [x] The reserved list is defined once (`indexer.ReservedFirstSegments`) and the preview builder reuses it.
- [x] The specification states that the indexer enforces the reservation (design: [TD20](../technical-design/TD20-search-results-page-and-snippet-packs.md); origin: [ISSUE-087](ISSUE-087-page-text-search-results-page.md)).
- [x] Unit tests cover both reserved names, the accepted look-alikes and the error text.

## Notes

Breaking for sites that already contain such paths; acceptable in 0.x (TD2). Ships with the next CLI release.
