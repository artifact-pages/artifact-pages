# IMP-29 — AWS production store and cache adapter

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-22](IMP-22-site-locks.md), [IMP-25](IMP-25-production-reconciler.md)
- Proves: S3/CloudFront smoke and failure-injection tests

## Outcome

Implement provider APIs behind the common registry, content, conditional-lock and cache interfaces for private S3 plus CloudFront.

## Acceptance criteria

- Read the deployed registry directly from S3; conditional writes satisfy lock CAS; listings consume every continuation page; delete batches inspect per-object errors.
- Object bytes, keys and MIME metadata preserve the provider-neutral projection; invalidation handles unregister paths and reports request failure.
- Tests cover pagination, more than one delete batch, conditional-write races, neighboring-prefix isolation, and real-provider smoke for these semantics.
- No AWS API type leaks into product domain models or the browser contract.
