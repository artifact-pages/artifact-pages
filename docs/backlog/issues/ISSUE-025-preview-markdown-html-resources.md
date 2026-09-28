# Bundle local images rendered from Markdown raw HTML

- Status: Open
- Priority: P2
- Area: Preview resource closure / Markdown
- Review: 2026-09-28, finding 12, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-03](../implementation/IMP-03-resource-bundle.md), [T6](../verification/T6-resources-navigation.md)

## Problem

The native Markdown reader supports sanitized raw HTML images, but the preview collector only sees Markdown image AST nodes. A supported `<img>` renders with a missing source because publication never bundles it.

## Evidence and reproduction

1. Commit a changed Markdown document with `<img src="diagram.svg" alt="Diagram">` and the local SVG in the head tree.
2. Pre-publish and inspect the manifest.
3. The document is published successfully, but diagram.svg is absent although the reader supports the image element.

Reviewed source: [internal/preview/resources.go:78](../../../internal/preview/resources.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / raw HTML image fixture`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Resources used by supported sanitized Markdown markup are present in a preview's head snapshot.

## Acceptance criteria

- [ ] Raw HTML image references and supported responsive-image references are collected consistently with reader/sanitizer behavior.
- [ ] Relative nested paths, spaces, and query/fragment components resolve to the intended bundled image.
- [ ] External HTTPS images stay external; unsupported/removed executable markup does not expand the resource closure.
- [ ] Add a head-tree collection regression and E2E checking actual image loading, not just alt-text presence.
