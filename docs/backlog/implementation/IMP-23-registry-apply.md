# IMP-23 — Apply the Git-owned registry

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-19](IMP-19-config-resolution.md), [IMP-20](IMP-20-registry-projection.md), [T11](../technical-design/T11-command-surface.md)
- Proves: admin apply/dry-run and serialization tests

## Outcome

Let the admin path reconcile root `sites.yaml` to deployed `/_indexes/sites.json` with a reviewable no-write plan.

## Acceptance criteria

- Dry-run reports exact additions, changes, removals and intended provider effects without writing; actual apply uses the same validated desired state.
- Registry deployments are serialized across processes so whole-object updates cannot overwrite each other.
- An already-applied registry is a successful no-op; failure reports whether the deployed registry changed and is safe to retry.
- The command reads YAML from the admin checkout; satellites never need it.
