# IMP-23 — Apply the Git-owned registry

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-19](IMP-19-config-resolution.md), [IMP-20](IMP-20-registry-projection.md), [IMP-22](IMP-22-site-locks.md), [T11](../technical-design/T11-command-surface.md)
- Proves: admin apply/dry-run and cross-process serialization; [T5](../verification/T5-concurrency-recovery.md), [T14](../verification/T14-production-reconciliation.md)

## Outcome

Let the admin path reconcile root `sites.yaml` to deployed `/_indexes/sites.json` with a reviewable no-write plan.

## Acceptance criteria

- Dry-run reports exact additions, changes, removals and intended provider effects without writing; actual apply uses the same validated desired state.
- Registry deployments are serialized across processes so whole-object updates cannot overwrite each other.
- An already-applied registry is a successful no-op; a private cleanup retry record preserves removed-site targets across failure after the registry write, and the result reports whether the deployed registry changed.
- The command reads YAML from the admin checkout; satellites never need it.

## Verification evidence

- `go test -race -count=1 ./internal/publisher` passes exact dry-run/apply plan comparison with zero dry-run writes, no-op JSON fields, delete and invalidation failure retries, and cross-process serialization while one process holds the registry lock.
- `go test -race -count=10 ./internal/publisher -run '^TestApplyRegistrySerializesSeparateProcesses$'` passes repeated contention runs.
- `go test -count=1 ./cmd/artifact-pages -run 'TestRunAdminApplyReadsManifestAndDryRunDoesNotCreateStorage|TestDeploymentResultReportsResolvedRemoteConfigCommit'` passes the local admin manifest dry-run/apply command flow and stable JSON envelope checks.
- `git diff --check` passes.
- The process test exercises the shared lock contract through separate local processes. Hosted AWS/Cloudflare behavior and delivery boundaries remain separate evidence gates in [T14](../verification/T14-production-reconciliation.md) and [T15](../verification/T15-provider-delivery.md).
