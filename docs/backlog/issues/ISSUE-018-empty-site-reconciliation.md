# Publish an empty site after its last document is removed

- Status: Open
- Priority: P2
- Area: Site publish / desired-state reconciliation
- Review: 2026-09-28, finding 05, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-25](../implementation/IMP-25-production-reconciler.md), [T14](../verification/T14-production-reconciliation.md)

## Problem

Deleting the last HTML/Markdown document makes index building fail before stale-object removal. The old artifact and index remain online even though Git no longer contains a document to publish. Keeping the site registered cannot converge to an empty state.

## Evidence and reproduction

1. Publish a registered source tree containing one HTML or Markdown document.
2. Delete that document and run ordinary site publish again.
3. The operation exits 1 for zero documents and leaves the old artifact/index at origin.

Reviewed source: [internal/publisher/site_publish.go:199](../../../internal/publisher/site_publish.go), [internal/indexer/build.go:215](../../../internal/indexer/build.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/empty-site-evidence.json`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

An empty document set is a valid desired state for a registered site, not an implicit unregister operation.

## Acceptance criteria

- [ ] Publishing after last-document deletion produces a valid zero-document index/meta and removes stale document objects.
- [ ] The reader handles the empty registered site without breaking other sites or routing to an implicit index document.
- [ ] Retry after an injected partial failure converges to the empty projection.
- [ ] Resources still present in the source follow normal projection rules; registry, app, control, preview-retention, and neighbor boundaries remain intact.
