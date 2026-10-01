# DOC-04 — Guide: publishing

- Status: Open
- Site: `guide`
- Page: `ja/publishing.html`, `en/publishing.html`
- Audience: Teams publishing from their own repositories
- Depends on: DOC-03

## Purpose

Explain how a team publishes its site: choosing a publishable directory, `site publish` with explicit `--site` and `--source`, running it from CI, and PR previews.

## Scope

- What belongs in `sourcePath` (ready-to-serve HTML/Markdown and resources; no build step).
- Dry-run then publish; what is created, updated, and removed; eligibility checks against the registry.
- Running the same command in CI on merge; optional GitHub Actions only once released.
- PR previews at the level a publisher needs.

## Out of scope

- Internals of reconciliation and locking (DOC-10) and preview storage (DOC-11).

## Primary sources

- [Specification §5 Publishable source directory, §6, §9, §12, §19 preview contract, §22](../../specification.md)
- [GitHub Actions](../../guides/github-actions.md), [Local preview development](../../guides/local-preview-development.md)

## Acceptance criteria

- [ ] `ja/publishing.html` and `en/publishing.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- Actions are optional and not yet released; confirm with the owner how much to show.

## Dependency on the release shape

This page refers to how components are obtained and pinned. Draft it after the release-shape decision recorded in [DOC-03](DOC-03-guide-getting-started.md#blocker-2026-10-01).
