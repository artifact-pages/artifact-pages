# DOC-05 — Guide: reading

- Status: Open
- Site: `guide`
- Page: `ja/reading.html`, `en/reading.html`
- Audience: Readers of published sites
- Depends on: DOC-02

## Purpose

Describe the reader experience: stable URLs, site home, sidebar, search with ⌘K / Ctrl K, `@` site switching, `#` headings, `>` commands, pins and recent reads.

## Scope

- URL shape and sharing; HTML vs Markdown rendering at the reader's level.
- Command palette modes and scopes (All, Recent, Pinned, Previews).
- Theme and narrow-screen behavior.

## Out of scope

- Implementation of search scoring and index loading.

## Primary sources

- [Specification §4 routing, §7 viewer, §8 browser UX](../../specification.md)
- `web/src/components/CommandPalette.tsx`, `SiteHome.tsx`, `Sidebar.tsx`

## Acceptance criteria

- [ ] `ja/reading.html` and `en/reading.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
