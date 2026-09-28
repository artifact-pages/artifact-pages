# Recognize static JavaScript module dependencies without matching ordinary strings

- Status: Open
- Priority: P2
- Area: Preview resource closure / JavaScript
- Review: 2026-09-28, finding 10, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-03](../implementation/IMP-03-resource-bundle.md), [T6](../verification/T6-resources-navigation.md)

## Problem

The module-reference extractor mistakes a string in an export declaration for a filename, and misses a valid multiline import. It either rejects a valid preview or reports success while omitting required code.

## Evidence and reproduction

1. Include `export const label = "Ready";` in a preview rendering dependency; publication tries to find a file named Ready and fails.
2. Separately use a multiline `import {\n label\n} from "./labels.js";` with labels.js present in the head tree.
3. Publication succeeds but omits labels.js from the bundle.

Reviewed source: [internal/preview/resources.go:22,133](../../../internal/preview/resources.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / Git and CLI resource cases`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Static module specifiers are collected reliably; ordinary exported data is not treated as a resource path.

## Acceptance criteria

- [ ] Tests cover side-effect, named, default, multiline import, and static re-export syntax plus non-specifier export strings and comments.
- [ ] Needed relative module dependencies are included transitively from the committed head tree.
- [ ] Missing/out-of-tree dependencies fail clearly; runtime-constructed URLs remain outside automatic guarantees.
- [ ] Exercise the resulting modules in a browser under the settled preview-delivery boundary, with T6 tracking end-to-end proof.
