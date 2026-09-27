# IMP-24 — Verify publisher identity against deployed registration

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-20](IMP-20-registry-projection.md), [IMP-22](IMP-22-site-locks.md)
- Proves: source-match and normal publish/unregister race tests; [T5](../verification/T5-concurrency-recovery.md), with broader production proof still tracked by [T14](../verification/T14-production-reconciliation.md)

## Outcome

Gate a selected site's normal publish on the current provider-origin registry and exact checkout source identity.

## Acceptance criteria

- Identify the checkout's GitHub `owner/repo` and exact selected `sourcePath`; require a matching registered pair and an existing directory under the checkout.
- For a real publish, authoritative deployed-registry read and validation occur after acquiring the site lock, not from CDN cache or admin YAML; dry-run remains read-only.
- Unregistered, mismatched, renamed, invalid or removed sites fail before content-plane writes; no branch is part of site identity.
- Tests exercise both publish-first and unregister-first interleavings.

## Evidence

`PublishSite` reads and validates the provider-origin registry only after acquiring the per-site lock, then compares the GitHub `owner/repo` and exact checkout-relative source path before planning content changes. Tests cover unregistered and renamed IDs, repository/source mismatches, invalid or missing registries, missing/outside/symlinked source directories, branch independence, and read-only dry-run behavior. A gated backend deterministically verifies both normal publish/unregister orderings and records that a rejected publish performs no content-plane mutations.

Verified:

- `go test -race -count=1 ./internal/publisher`
- `go test -race -count=1 ./internal/indexer`
- `go test -race -count=10 ./internal/publisher -run 'Test(PublishFirstThenUnregisterWithdrawsAndCleansSite|UnregisterFirstBlocksPublishBeforeContentWrites)'`

These are local contract tests; provider-hosted conditional-write, listing, invalidation, and recovery evidence remains open under T14/T15.
