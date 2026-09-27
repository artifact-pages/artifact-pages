# IMP-26 — Explicit site publish and dry-run

- Status: Done
- Phase: Phase 1 local registered-site publishing
- Depends on: [IMP-19](IMP-19-config-resolution.md), [IMP-24](IMP-24-publisher-eligibility.md), [IMP-25](IMP-25-production-reconciler.md), [T11](../technical-design/T11-command-surface.md)
- Proves: CLI help/plan tests and local end-to-end publish

## Outcome

Make one `artifact-pages` publish path build the existing index, compare desired and deployed state, then synchronize the explicitly selected site.

## Acceptance criteria

- Exact public syntax follows T11; the site is always explicit and no standalone index build is required for normal publish.
- Dry-run lists creates, updates and stale removals, including index/meta, without provider writes; real publish uses the same selection and eligibility logic.
- The local CLI invokes the shared `publisher.PublishSite` operation. Local process tests verify machine-readable success, no-op, provider/config failure results, and exit codes. CI wrapper parity is outside this ticket and remains in [IMP-34](IMP-34-actions.md) and [T8](../verification/T8-stale-reference-cleanup.md).
- Integrate [IMP-06](IMP-06-production-reconciliation.md) so production publish also prunes missing preview references without deleting live previews solely because a PR merged.

## Evidence

`cmd/artifact-pages/main_test.go` exercises the CLI process against a local configured backend: dry-run reports production and preview changes without modifying storage, publish applies the plan, a repeat is a machine-readable no-op, and failure cases return stable JSON with the expected exit codes. `internal/publisher/site_publish_preview_test.go` verifies the IMP-06 production/preview ordering and retry behavior. `go test -race -count=1 ./...` passes. CI wrapper parity and provider-origin behavior are tracked separately by IMP-34 and T8/T14/T15.
