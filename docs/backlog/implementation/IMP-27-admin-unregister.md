# IMP-27 — Remove registration and its site projection

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-22](IMP-22-site-locks.md), [IMP-23](IMP-23-registry-apply.md), [IMP-25](IMP-25-production-reconciler.md)
- Proves: unregister/retry and cache tests; [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Make removal from the admin manifest withdraw publisher eligibility and delete the selected site's deployed data, with no extra paused state.

## Acceptance criteria

- Serialize admin registry deployment, publish the registry without the site, acquire its lock, fully list and delete exact site index/artifact prefixes, then request affected CDN invalidation/revalidation.
- Missing or already removed registration remains an explicit cleanup target; partial deletion or cache-request failure reports failure and a retry converges.
- Integrate [IMP-16](IMP-16-unregister.md) for preview data; leave control lock records and all neighboring site/app/registry objects intact.
- Tests prove both publish/unregister orderings and failed invalidation followed by retry.
