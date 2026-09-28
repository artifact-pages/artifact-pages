# Allow same-head preview retries when only the default branch advances

- Status: Open
- Priority: P2
- Area: Preview revision identity / idempotency
- Review: 2026-09-28, finding 09, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-05](../implementation/IMP-05-publication.md), [T5](../verification/T5-concurrency-recovery.md)

## Problem

DefaultHead is compared as immutable projection identity. An unrelated default-branch commit makes retrying an unchanged preview head fail even when merge-base, selected documents, and bundle bytes are identical. Comparison provenance is incorrectly changing revision identity.

## Evidence and reproduction

1. Publish a preview head and retain its completed manifest and catalog.
2. Advance the default branch with an unrelated commit without modifying the preview branch or merge-base.
3. Republish the same head. The review observed 'different immutable projection' despite identical selected content.

Reviewed source: [internal/preview/store.go:554](../../../internal/preview/store.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/preview-evidence.md / same-head retry`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

An observed default-head advance alone does not invalidate a fixed head snapshot or extend its retention through rewrites.

## Acceptance criteria

- [ ] Retry with a new default HEAD but unchanged merge-base/document set/bytes succeeds idempotently at the same URL.
- [ ] Existing completed objects are verified, not rewritten merely to refresh provenance or retention.
- [ ] A genuinely different document selection or bundle for the same head still fails immutability checks.
- [ ] Tests distinguish recorded comparison provenance, discovery group context, and immutable revision identity.
