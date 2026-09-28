# Resolve fragments when linking to another Markdown document

- Status: Open
- Priority: P2
- Area: Markdown reader / document navigation
- Review: 2026-09-28, finding 17, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`

## Problem

Cross-document Markdown links retain an unprefixed fragment even though generated reader IDs use `md-`. The intended document loads, but the browser stays at the top; same-document fragments use different handling.

## Evidence and reproduction

1. Open Markdown with a relative link `../runbooks/service-recovery.md#recovery-steps`.
2. Follow it to a document whose heading ID is `md-recovery-steps`.
3. The review recorded the destination loading with scrollTop=0 while the target remained around Y=3071.

Reviewed source: [src/components/MarkdownArtifact.tsx:245](../../../src/components/MarkdownArtifact.tsx). The review's supplementary local evidence is `.local/reviews/2026-09-28/browser-evidence.json / crossDocumentFragment`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Relative links to Markdown headings land on the heading, using the same ID convention as the destination reader.

## Acceptance criteria

- [ ] Cross-document and same-document Markdown fragments land on headings, including duplicate IDs and already-prefixed fragments.
- [ ] Do not prefix twice; URL encoding, query parameters, and relative-path resolution remain correct.
- [ ] HTML destination fragments retain their original IDs and behavior.
- [ ] Direct load/reload and browser back/forward preserve the destination and heading; test actual scroll/visibility.
