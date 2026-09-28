# IMP-23 — Register the Git-owned site set

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-19](IMP-19-config-resolution.md), [IMP-20](IMP-20-registry-projection.md), [IMP-22](IMP-22-site-locks.md), [T11](../technical-design/T11-command-surface.md)
- Proves: `registry register` dry-run, complete-set reconciliation and cleanup, and cross-process serialization; [T5](../verification/T5-concurrency-recovery.md), [T14](../verification/T14-production-reconciliation.md)

## Outcome

Let `registry register` validate root `sites.yaml`, create its `/_indexes/sites.json` projection, and reconcile the configured target to the complete desired registration set with a reviewable no-write plan in one operation. Clean content prefixes for sites omitted from the manifest.

## Acceptance criteria

- Dry-run reports exact registration additions, changes, removals and intended provider effects without writing; the real registration uses the same validated complete desired state and cleans prefixes for omitted sites.
- Registry registration/reconciliation is serialized across processes so whole-object updates cannot overwrite each other.
- An already-applied registry is a successful no-op; a private cleanup retry record preserves removed-site targets across failure after the registry write, and the result reports whether the deployed registry changed.
- The command reads YAML from the admin checkout; satellites never need it.

## Verification evidence

- `go test -race -count=1 ./internal/publisher` passes exact dry-run/apply plan comparison with zero dry-run writes, no-op JSON fields, delete and invalidation failure retries, and cross-process serialization while one process holds the registry lock.
- `go test -race -count=10 ./internal/publisher -run '^TestRegisterSitesSerializesSeparateProcesses$'` passes repeated contention runs.
- `go test -count=1 ./cmd/artifact-pages -run 'TestRunRegistryRegisterReadsManifestAndDryRunDoesNotCreateStorage|TestDeploymentResultReportsResolvedRemoteConfigCommit'` passes the manifest-driven registry registration dry-run/apply command flow and stable JSON envelope checks.
- `git diff --check` passes.
- The process test exercises the shared lock contract through separate local processes. Hosted AWS/Cloudflare behavior and delivery boundaries remain separate evidence gates in [T14](../verification/T14-production-reconciliation.md) and [T15](../verification/T15-provider-delivery.md).
