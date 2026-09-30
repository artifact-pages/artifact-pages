# DOC-12 — Architecture: trust model

- Status: Open
- Site: `architecture`
- Page: `ja/trust-model.html`, `en/trust-model.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-08

## Purpose

Explain the trust model behind DOC-07: HTML rendered as trusted same-origin content in an iframe, sanitized Markdown, per-site CSP, and why viewer identity is out of scope.

## Scope

- The threat model the product accepts and what it does not defend against.
- Per-site CSP and its consequences (for example, no cross-site shared assets).

## Out of scope

- Operational access setup (DOC-07).

## Primary sources

- [Specification §7, §18, §21](../../specification.md), [TD1](../technical-design/TD1-site-viewer-access.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)

## Acceptance criteria

- [ ] `ja/trust-model.html` and `en/trust-model.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
