# IMP-22 — Shared per-site lock and guarded recovery

- Status: Open
- Phase: Provider-backed deployment
- Depends on: provider store conditional-write capability
- Proves: concurrency and recovery tests; [T5](../verification/T5-concurrency-recovery.md)

## Outcome

Give satellite publish and admin unregister one provider-neutral, fail-closed per-site coordination protocol.

## Acceptance criteria

- First creation is atomic; later acquire/release/recover use ETag compare-and-swap on a retained free/held record outside public site prefixes.
- Bounded waiting cannot steal a held lock; process interruption leaves it held for explicit inspection and guarded recovery.
- CLI exposes inspection and stale-lock recovery as settled in T11; a changed ETag prevents recovery of a newer owner's lock.
- Deterministic concurrent tests cover same-site exclusion, independent sites, interruption, and recovery races.
