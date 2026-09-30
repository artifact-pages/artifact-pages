# DOC-10 — Architecture: publishing model

- Status: Open
- Site: `architecture`
- Page: `ja/publishing-model.html`, `en/publishing-model.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-09

## Purpose

Explain how publishing converges: desired-state synchronization, digest-based change detection, idempotent retry, locks, registry eligibility, and concurrent publish/unregister.

## Scope

- The plan/apply sequence and what dry-run shows.
- Failure and retry behavior; why there is no rollback transaction.

## Out of scope

- CLI usage (DOC-04).

## Primary sources

- [Specification §5 Publishable source directory, §11 concurrent publish and unregister, §17 object-prefix reconciliation](../../specification.md), [T14](../verification/T14-production-reconciliation.md)

## Acceptance criteria

- [ ] `ja/publishing-model.html` and `en/publishing-model.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
