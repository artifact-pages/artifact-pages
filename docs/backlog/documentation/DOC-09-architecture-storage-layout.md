# DOC-09 — Architecture: storage layout

- Status: Open
- Site: `architecture`
- Page: `ja/storage-layout.html`, `en/storage-layout.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-08

## Purpose

Describe the published object layout: `sites.json`, per-site `meta.json` and `index.json`, artifact keys, how routes map to keys, and cache policy per plane.

## Scope

- Object map with examples; how discovery and per-site index loading work.
- Cache-Control per object class and why.

## Out of scope

- Provider-specific bucket and CDN configuration.

## Primary sources

- [Specification §5, §6 HTTP representation metadata, §16 cache model](../../specification.md)

## Acceptance criteria

- [ ] `ja/storage-layout.html` and `en/storage-layout.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
