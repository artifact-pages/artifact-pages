# IMP-27 — Remove registration and its site projection

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-22](IMP-22-site-locks.md), [IMP-23](IMP-23-registry-apply.md), [IMP-25](IMP-25-production-reconciler.md)
- Proves: unregister/retry and cache tests; [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Make removal from the admin manifest withdraw publisher eligibility and delete the selected site's deployed data, with no extra paused state.

## Acceptance criteria

- Reconcile the admin manifest without the site, withdraw its registration, acquire its lock, fully list and delete exact site index/artifact prefixes, then request affected CDN invalidation/revalidation.
- Missing or already removed registration remains an explicit cleanup target; partial deletion or cache-request failure reports failure and a retry converges.
- Integrate [IMP-16](IMP-16-unregister.md) for preview data; leave control lock records and all neighboring site/app/registry objects intact.
- Tests prove both publish/unregister orderings and failed invalidation followed by retry.

## Evidence

`internal/publisher/registry_apply.go` withdraws eligibility before listing and deleting the selected site's artifact, index, and preview objects under its site lock, then invalidates affected routes and retains a cleanup record until the whole operation succeeds. `TestUnregisterSiteRetriesRemovedSiteCleanupAfterPostWriteFailures` injects listing, partial-delete, and invalidation failures after registration removal, then verifies dry-run and real retry both include the complete catalog/site/preview path set and preserve the deployed registry, neighboring sites, app plane, and unrelated control data. `TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent` covers forced cleanup retries. `TestPublishFirstThenUnregisterWithdrawsAndCleansSite` and `TestUnregisterFirstBlocksPublishBeforeContentWrites` prove both site-publish orderings with preview objects seeded. `TestRegistryUnregisterLocalCLIIsScopedRetryableAndMachineReadable` covers help, dry-run, success, repeat cleanup, invalid input, failure JSON/exit status, and retry. The local test suite passes with `go test -race -count=1 ./...`.

Preview-writer/unregister races and live provider behavior remain separate evidence gates in [IMP-16](IMP-16-unregister.md), [T5](../verification/T5-concurrency-recovery.md), and [T14](../verification/T14-production-reconciliation.md).
