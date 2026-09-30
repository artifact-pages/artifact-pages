# DOC-08 — Architecture: overview and site registration

- Status: Open
- Site: `architecture`
- Page: `ja/overview.html`, `en/overview.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-01

## Purpose

Explain the system shape: the stable application plane (`/index.html`, `/assets/*`), the changing content plane (`/_indexes/*`, `/_artifacts/*`), static delivery, and Git as the source of truth. This ticket also creates and registers the `architecture` site.

## Scope

- Create `docs/public/sites/architecture/{ja,en,assets}` using the shared assets from DOC-01.
- Register `architecture` with the name and description from the track README; publish.
- The two planes, logical routes vs storage paths, and why there is no request-time server.
- Links from the guide overview to this page.

## Out of scope

- Storage details (DOC-09) and publish mechanics (DOC-10).

## Primary sources

- [Thesis](../../thesis.md), [Specification §1–§5, §21 invariants](../../specification.md)

## Acceptance criteria

- [ ] `ja/overview.html` and `en/overview.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
