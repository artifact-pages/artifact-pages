# IMP-15 — Provider-owned preview retention configuration

- Status: Open
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority.
- Depends on: [IMP-12](IMP-12-provider-boundary.md) and the provider mapping in [T3](../technical-design/T3-provider-retention.md)
- Proves: [T4](../verification/T4-serving-boundary.md), [T8](../verification/T8-stale-reference-cleanup.md)

## Outcome

Configure the administrator's single preview-retention policy in the provider's infrastructure/module, including revision files, manifests, catalog inactivity and retained object versions. Do not implement an application expiry clock or per-PR duration.

## Acceptance criteria

- Provider lifecycle configuration covers every preview object class and retained version; an inactive site does not accumulate a permanently orphaned catalog.
- A manifest may disappear before its catalog reference; reader hiding and later catalog pruning follow provider availability rather than app time.
- Integration evidence documents asynchronous removal and cache lag, including the limitation that retention is not exact revocation.
- The provider-neutral contract remains separate from the adapter-specific configuration and T3 records the mapping.
