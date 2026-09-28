# IMP-16 — Unregister preview projection cleanup

- Status: Done
- Phase: Post-MVP preview
- Depends on: [IMP-05](IMP-05-publication.md) and the existing registry unregister integration point.
- Proves: [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Under the shared per-site lock, `registry unregister` withdraws the site's registration and removes its preview catalog, manifests and bundle objects together with its production projection. Concurrent publishers must not recreate the removed site after unregister.

## Acceptance criteria

- Both publish-first and unregister-first orderings converge on an unregistered site with no site preview objects; other sites remain untouched.
- Interrupted/partial unregister and multi-page object listings converge on retry without treating partial listings as complete.
- A publisher that acquires the lock after withdrawal fails registry revalidation before uploading; no new preview becomes discoverable.
- Provider-fake concurrency tests verify this implementation's ordering, revalidation and cleanup behavior. Broader provider-adapter and live-service recovery evidence remains in [T5](../verification/T5-concurrency-recovery.md), independently of production publish's stale-catalog pruning.

## Local evidence

`go test ./internal/publisher -run '^(TestBuildAndPublishPreviewFirstThenUnregisterCleansPreview|TestUnregisterFirstRejectsPreviewPublisherAfterLockAndBeforeUpload|TestUnregisterSiteCleansEveryAWSListingPageWithFakeBackend|TestUnregisterSiteRetriesAfterAWSContinuationListingFailure|TestObjectPreviewStoreDoesNotDeleteAfterPartialSiteListing)$' -count=1` passes. The race tests cover both operation orders, registry revalidation after lock acquisition, zero preview uploads after withdrawal, and site isolation. Fake AWS pagination tests prove complete multi-page cleanup and that a failed continuation listing performs no deletion, retains retry state, then converges while preserving neighboring objects, control data, and free locks. A provider-neutral adapter fake also verifies no deletion follows a partial listing and that retry removes all target prefixes. These deterministic implementation checks satisfy this ticket's cleanup and race criteria. They do not claim live AWS/R2 adapter behavior: real-provider smoke and the remaining cross-process/provider recovery checks remain tracked separately in [T5](../verification/T5-concurrency-recovery.md).
