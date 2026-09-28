# Include static imports from inline HTML module scripts

- Status: Open
- Priority: P2
- Area: Preview resource closure / HTML
- Review: 2026-09-28, finding 11, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-03](../implementation/IMP-03-resource-bundle.md), [T6](../verification/T6-resources-navigation.md)

## Problem

An inline module's static imports are not collected. HTML publication succeeds with a document-only manifest even though the required local module is present in the Git head tree.

## Evidence and reproduction

1. Commit a changed HTML document containing `<script type="module">import "./app.js";</script>`.
2. Keep app.js and its rendering dependencies inside the registered source tree and pre-publish.
3. The review observed a manifest containing only the HTML document; the module is absent.

Reviewed source: [internal/preview/resources.go:102](../../../internal/preview/resources.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / inline module fixture`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Statically resolvable inline-module imports participate in the same head-snapshot rendering closure as external modules.

## Acceptance criteria

- [ ] Inline module imports and their transitive local dependencies appear in the bundle/manifest with correct relative paths.
- [ ] External HTTPS imports stay external; missing and out-of-tree static local imports fail clearly.
- [ ] Inline ordinary scripts and unrelated strings do not create fabricated dependencies.
- [ ] Add a collector regression and browser execution case; use the settled T6/TD3 delivery boundary rather than permissive diagnostic CORS.
