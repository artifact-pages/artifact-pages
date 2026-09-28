# Preserve raw filenames in preview object keys

- Status: Open
- Priority: P1
- Area: Preview publish / storage codec
- Review: 2026-09-28, finding 02, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-05](../implementation/IMP-05-publication.md), [T6](../verification/T6-resources-navigation.md)

## Problem

The shared object-backed preview adapter stores URL-encoded segments as literal object keys, unlike the directory preview store. Valid filenames therefore need double encoding to load. AWS and R2 use the same adapter, but live cloud behavior was not exercised.

## Evidence and reproduction

1. Commit a previewable document named `page space.html` and relative resources with spaces or reserved characters.
2. Publish through a configured local target, rather than only the dedicated preview-local helper, and request the returned document/resource URL through the edge.
3. The stored filename is `page%20space.html`: a normal `%20` URL returns 404 while a `%2520` URL returns 200.

Reviewed source: [internal/publisher/preview_adapter.go:177](../../../internal/publisher/preview_adapter.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / configured-local HTTP reproduction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Storage preserves source-relative UTF-8 names. URLs encode each segment once, and every adapter agrees on the same raw key.

## Acceptance criteria

- [ ] Documents and resources containing spaces, Unicode, `#`, `%`, `?`, and literal `+` round-trip with normally encoded URLs and no double-encoding requirement.
- [ ] Directory and object-backed stores share key/URL conformance tests, including traversal and decode-at-most-once checks.
- [ ] Published manifest paths, raw keys, reader resolution, and returned URLs agree without renaming source files.
- [ ] Reconcile the contradictory 'URL-encoded segments in storage keys' wording in the preview publishing contract with the specification's raw-key rule.
