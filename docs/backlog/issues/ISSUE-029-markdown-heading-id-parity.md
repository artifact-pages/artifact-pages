# Generate the same Markdown heading IDs in the builder and reader

- Status: Open
- Priority: P2
- Area: Markdown index / Contents / heading search
- Review: 2026-09-28, finding 16, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`

## Problem

The index builder slugifies raw heading text while the reader derives IDs from rendered text. Entities, inline HTML, and images produce different IDs, so Contents and heading search cannot reach the rendered heading.

## Evidence and reproduction

1. Build and open Markdown containing `# Foo &amp; Bar` and headings with inline HTML or images.
2. Compare indexed heading IDs with DOM IDs, then activate Contents or heading search.
3. The review recorded builder `md-foo-amp-bar` versus reader `md-foo--bar` for the entity heading, with other mismatches too.

Reviewed source: [internal/indexer/build.go:605](../../../internal/indexer/build.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/indexer-evidence.json; browser-evidence.json`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Precomputed Markdown heading metadata points to the exact IDs used by the native reader.

## Acceptance criteria

- [ ] Shared conformance fixtures cover entities, inline formatting/HTML, image alt text, Unicode, empty headings, and duplicate headings.
- [ ] Builder and reader agree on rendered text extraction, slug normalization, duplicate suffixes, and the Markdown prefix.
- [ ] Contents and palette heading navigation actually scroll to rendered headings in browser tests.
- [ ] HTML heading IDs and explicit artifact paths remain unchanged; resolve the implementation mismatch rather than weakening the contract.
