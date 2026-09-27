# IMP-24 — Verify publisher identity against deployed registration

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-20](IMP-20-registry-projection.md), [IMP-22](IMP-22-site-locks.md)
- Proves: source-match and publish/unregister race tests; [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Gate a selected site's normal publish on the current provider-origin registry and exact checkout source identity.

## Acceptance criteria

- Identify the checkout's GitHub `owner/repo` and exact selected `sourcePath`; require a matching registered pair and an existing directory under the checkout.
- Authoritative deployed-registry read and validation occur after acquiring the site lock, not from CDN cache or admin YAML.
- Unregistered, mismatched, renamed, invalid or removed sites fail before content-plane writes; no branch is part of site identity.
- Tests exercise both publish-first and unregister-first interleavings.
