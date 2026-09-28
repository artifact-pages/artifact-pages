# Apply HTML preview fragments to the rendered frame

- Status: Open
- Priority: P2
- Area: Preview reader / heading navigation
- Review: 2026-09-28, finding 15, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-08](../implementation/IMP-08-preview-reader.md), [T6](../verification/T6-resources-navigation.md)

## Problem

Preview route hashes are passed to Markdown but not applied to HTML frames. Clicking a fragment changes the parent URL without scrolling the document; shared deep links and reloads also miss the target.

## Evidence and reproduction

1. Open a tall HTML preview with an element id `deep-target` and a link `href="#deep-target"`.
2. Click that link and then directly load/reload the logical preview URL with the same fragment.
3. The parent hash changes, but the review recorded an empty frame hash, scrollY=0, and the target still around Y=3328.

Reviewed source: [src/components/PreviewDocumentPage.tsx:119,206](../../../src/components/PreviewDocumentPage.tsx). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / deep-target browser interaction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

The logical preview URL's fragment reaches the intended HTML element without changing preview identity.

## Acceptance criteria

- [ ] Same-document fragment clicks, fragment-bearing direct loads/reloads, and changed-document links scroll to the intended target.
- [ ] Browser back/forward and delayed frame load retain correct fragment synchronization.
- [ ] Missing IDs do not break the document or navigation; query and PR-group context remain intact.
- [ ] The behavior works under the chosen local/provider frame boundary without introducing same-origin app DOM access.
