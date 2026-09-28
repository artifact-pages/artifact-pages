# Retain catalog invalidation when retrying an unregister

- Status: Open
- Priority: P2
- Area: Registry publish / unregister recovery
- Review: 2026-09-28, finding 07, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-27](../implementation/IMP-27-admin-unregister.md), [T14](../verification/T14-production-reconciliation.md)

## Problem

After registry withdrawal and origin cleanup succeed but invalidation fails, the retry sees unchanged registry bytes and omits `/_indexes/sites.json` from invalidation. It reports success even though cached discovery can still list the removed site.

## Evidence and reproduction

1. Unregister an existing published site and inject failure in the final cache invalidation request.
2. Retry the same desired manifest after origin withdrawal has already completed.
3. The recorded invalidation set shrinks from six paths to five: the catalog path disappears because registryChanged is false.

Reviewed source: [internal/publisher/registry_apply.go:199](../../../internal/publisher/registry_apply.go). The review's supplementary local evidence is `.local/reviews/2026-09-28/storage-evidence.log / TestReviewUnregisterRetriesRegistryInvalidation`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

A retry completes every outstanding cache request required by the original unregister, regardless of already-converged origin bytes.

## Acceptance criteria

- [ ] The regression fails without catalog invalidation and passes only when the retry includes the complete catalog/site/preview cache set.
- [ ] Pending cleanup state survives post-write, delete, and invalidation failure, and clears only after all required requests succeed.
- [ ] Repeated retries are idempotent and preserve the registry, other sites, app plane, and unrelated control records.
- [ ] Dry-run accurately reports remaining work without changing cache or retry records; real CDN propagation remains a verification gate.
