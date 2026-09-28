# Do not swallow links to raw resources in HTML previews

- Status: Open
- Priority: P2
- Area: Preview reader / link navigation
- Review: 2026-09-28, finding 14, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-08](../implementation/IMP-08-preview-reader.md), [T6](../verification/T6-resources-navigation.md)

## Problem

The bridge prevents default navigation for bundled links, while the parent handles only HTML/Markdown destinations. A link to a bundled SVG or PDF is intercepted and then ignored, leaving the visitor with no response.

## Evidence and reproduction

1. Include a bundled SVG resource and an HTML preview link to `../assets/mark.svg`.
2. Click the link in the HTML preview.
3. Neither the frame nor the parent navigates in the recorded browser reproduction.

Reviewed source: [public/preview-bridge.js:50](../../../public/preview-bridge.js), [src/components/PreviewDocumentPage.tsx:263](../../../src/components/PreviewDocumentPage.tsx). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / SVG link browser interaction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Safe raw-resource links remain usable without being misrepresented as routable document artifacts.

## Acceptance criteria

- [ ] Links to bundled SVG, PDF, and download-style resources have an observable safe open/navigation outcome.
- [ ] Changed-document links still move the parent to the same preview revision; unchanged documents still open production routes.
- [ ] External HTTPS, query/fragment, modifier-click, and target/download intent retain appropriate behavior.
- [ ] Unsafe or out-of-bound destinations stay rejected; add browser tests for resources as distinct from indexed documents.
