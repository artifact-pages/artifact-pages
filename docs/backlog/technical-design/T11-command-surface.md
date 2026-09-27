# T11 — Registry, site and application command surface

- Status: Open
- Phase: Provider-backed deployment

## Design question

What are the exact public commands and dry-run output for applying a Git-owned registry, publishing an explicitly selected site, deploying the versioned application bundle, and inspecting/recovering locks?

## Exit criteria

- [ ] Resolve verb/flag names and exit codes without exposing a standalone index build as the required publish path.
- [ ] Define a consistent `--dry-run` that compares desired and deployed state without provider writes, for admin and satellite workflows.
- [ ] Define machine-readable plans/results, explicit site selection, and the boundary between CLI operations and optional thin GitHub Actions wrappers.
- [ ] Align preview CLI work in [T2](T2-cli-action-interface.md) without making preview a prerequisite for normal publish.
- [ ] Record agreed interface in the specification and CLI help before implementation is marked complete.

## Evidence

Not yet recorded. Command names and output shapes remain design work.
