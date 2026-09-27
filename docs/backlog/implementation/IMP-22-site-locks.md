# IMP-22 — Shared per-site lock and guarded recovery

- Status: Done
- Phase: Provider-backed deployment
- Depends on: provider store conditional-write capability, using AWS S3's conditional-write contract in [Specification §17](../../specification.md#17-publishing-and-aws-credentials) and the Cloudflare mappings in [T9](../technical-design/T9-cloudflare-store-mapping.md) and [T12](../technical-design/T12-cloudflare-production-mapping.md)
- Proves: deterministic local concurrency and recovery tests; [T5](../verification/T5-concurrency-recovery.md), [T14](../verification/T14-production-reconciliation.md). Provider public-access proof remains in [T15](../verification/T15-provider-delivery.md).

## Outcome

Give satellite publish and admin unregister one provider-neutral, fail-closed per-site coordination protocol.

## Acceptance criteria

- First creation is atomic; later acquire/release/recover use ETag compare-and-swap on a retained free/held record outside public site prefixes.
- Bounded waiting cannot steal a held lock; process interruption leaves it held for explicit inspection and guarded recovery.
- CLI exposes inspection and stale-lock recovery as settled in T11; a changed ETag prevents recovery of a newer owner's lock.
- Deterministic concurrent tests cover same-site exclusion, independent sites, interruption, and recovery races.

## Verification evidence

- `go test -race -count=1 ./internal/publisher` passes deterministic same-site first-create/exclusion, independent-site concurrency, interrupted-holder timeout and inspection, stale-ETag protection, concurrent recovery CAS, and stale-release tests.
- `go test -count=1 ./cmd/artifact-pages -run 'TestLockCLIInspectsAndRecoversUsingObservedETag'` passes the local CLI inspect/recover JSON flow.
- The conditional-write adapter test verifies S3 `If-None-Match: *`, ETag `If-Match`, 412 conflict mapping, and Cloudflare R2 delegation through the same S3 adapter.
- Provider-hosted visibility, authorization, and real-service conditional-write behavior remain separate evidence gates in [T14](../verification/T14-production-reconciliation.md) and [T15](../verification/T15-provider-delivery.md); this ticket closes the shared protocol and local deterministic proof.
