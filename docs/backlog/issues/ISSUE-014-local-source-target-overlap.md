# Reject overlapping local source and publish output

- Status: Open
- Priority: P1
- Area: Site publish / local storage
- Review: 2026-09-28, finding 01, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-25](../implementation/IMP-25-production-reconciler.md), [T14](../verification/T14-production-reconciliation.md)

## Problem

A valid sourcePath of `.` can contain the configured local storage root. Publishing reads its own output and copies private control records into public artifacts. Repeating the operation recursively republishes earlier output; neighboring sites can also enter the source projection.

## Evidence and reproduction

1. Use one Git checkout with sourcePath `.` and a local deployment root `.local/storage` inside it.
2. Publish a registered site, then inspect its artifact prefix and repeat the publish.
3. The review observed `_artifacts/sre/.local/storage/_control/locks/sites/sre.json`, including the held lock owner. The published file count increased from 10 to 13 on the second run.

Reviewed source: [internal/publisher/site_publish.go:315–321](../../../internal/publisher/site_publish.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/storage-evidence.log / TestReviewNestedLocalTarget`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

The publisher refuses an unsafe source/output boundary before publishing private or recursive output. Legitimate ignored/generated source files remain publishable.

## Acceptance criteria

- [ ] An equal or overlapping resolved source/local-target boundary fails before lock creation, object writes, or deletion; cover both containment directions.
- [ ] A regression reproduces the nested-target configuration and proves no control data, earlier output, or neighboring-site content is published.
- [ ] Non-overlapping targets still publish intentionally ignored/generated regular source files; do not use Gitignore as a substitute boundary.
- [ ] Dry-run and normal publish report the same unsafe configuration clearly.
