# Keep Unicode filenames readable in fallback artifact titles

- Status: Open
- Priority: P2
- Area: Indexer / artifact display title
- Review: 2026-09-28, finding 18, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`

## Problem

The fallback title uppercases a first byte rather than a complete UTF-8 character. Non-ASCII filenames without a title/H1 become replacement characters in discovery and search even though their paths are valid.

## Evidence and reproduction

1. Create `設計.md` without an H1 and build the site index.
2. Inspect its title and display it in navigation/search.
3. The review recorded the fallback title `���計` instead of the readable filename.

Reviewed source: [internal/indexer/build.go:939](../../../internal/indexer/build.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/indexer-evidence.json`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Filename-derived display titles preserve valid Unicode without changing artifact identity or routes.

## Acceptance criteria

- [ ] Fallback title tests cover Japanese, other multibyte letters, emoji, ASCII, and mixed filenames without replacement characters.
- [ ] Missing Markdown H1 and HTML title follow the documented fallback behavior; explicit titles remain unchanged.
- [ ] Indexer output and browser search/tree display stay readable.
- [ ] Source paths, URL encoding, and extension retention are untouched.
