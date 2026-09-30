# DOC-11 — Architecture: previews

- Status: Open
- Site: `architecture`
- Page: `ja/previews.html`, `en/previews.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-10

## Purpose

Explain the pull-request preview model: preview records and revision manifests, routes, retention, and stale-reference cleanup.

## Scope

- How a preview is created, found, and cleaned up.

## Out of scope

- Publisher-facing how-to (DOC-04).

## Primary sources

- [Specification §19 pre-publish preview contract](../../specification.md), [Preview decisions](../../architecture/preview-decisions.md), [T1](../technical-design/T1-preview-record-contract.md), [T3](../technical-design/T3-provider-retention.md)

## Acceptance criteria

- [ ] `ja/previews.html` and `en/previews.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
