# IMP-34 — Thin admin and site GitHub Actions

- Status: Open
- Phase: Reusable distribution
- Depends on: [IMP-23](IMP-23-registry-apply.md), [IMP-26](IMP-26-site-publish-command.md), [IMP-31](IMP-31-app-distribution.md), [T11](../technical-design/T11-command-surface.md)
- Proves: Actions integration with OIDC and local CLI parity

## Outcome

Offer optional, versioned Action entry points for registry/application and site workflows while leaving trigger timing to each adopting repository.

## Acceptance criteria

- Wrappers call the same CLI operations and expose typed outputs/exit status; PR workflows can use dry-run, and merge or other chosen events can apply/publish.
- Examples show least-privilege admin versus satellite credentials, explicitly selected site and pinned component versions.
- No required reusable workflow, implicit PR discovery, or mandatory preview cleanup workflow is introduced; compose preview [IMP-13](IMP-13-action.md) where appropriate.
- A smoke test compares direct CLI and Action results for equivalent inputs.
