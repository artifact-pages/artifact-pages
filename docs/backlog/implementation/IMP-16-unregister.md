# IMP-16 — Unregister preview projection cleanup

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-05](IMP-05-publication.md) and the existing admin unregister integration point.
- Proves: [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Under the shared per-site lock, admin unregister withdraws the site and removes its preview catalog, manifests and bundle objects together with its production projection. Concurrent publishers must not recreate the removed site after registry withdrawal.

## Acceptance criteria

- Both publish-first and unregister-first orderings converge on an unregistered site with no site preview objects; other sites remain untouched.
- Interrupted/partial unregister and multi-page object listings converge on retry without treating partial listings as complete.
- A publisher that acquires the lock after withdrawal fails registry revalidation before uploading; no new preview becomes discoverable.
- Provider-fake concurrency tests and later adapter smoke tests supply T5 evidence, independently of production publish's stale-catalog pruning.
