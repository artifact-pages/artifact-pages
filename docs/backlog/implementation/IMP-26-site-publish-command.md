# IMP-26 — Explicit site publish and dry-run

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [IMP-19](IMP-19-config-resolution.md), [IMP-24](IMP-24-publisher-eligibility.md), [IMP-25](IMP-25-production-reconciler.md), [T11](../technical-design/T11-command-surface.md)
- Proves: CLI help/plan tests and local end-to-end publish

## Outcome

Make one `artifact-pages` publish path build the existing index, compare desired and deployed state, then synchronize the explicitly selected site.

## Acceptance criteria

- Exact public syntax follows T11; the site is always explicit and no standalone index build is required for normal publish.
- Dry-run lists creates, updates and stale removals, including index/meta, without provider writes; real publish uses the same selection and eligibility logic.
- Local and CI invocations call the same operation; failure and no-op results are machine-readable.
- Integrate [IMP-06](IMP-06-production-reconciliation.md) so production publish also prunes missing preview references without deleting live previews solely because a PR merged.
