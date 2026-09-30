# DOC-07 — Guide: access and trust

- Status: Open
- Site: `guide`
- Page: `ja/access-and-trust.html`, `en/access-and-trust.html`
- Audience: Admins and teams deciding whether and what to publish
- Depends on: DOC-02

## Purpose

State what adopters must know before publishing: HTML is executable and must come from trusted sources, Markdown is sanitized, and viewer access control is configured at the delivery edge, not in the product.

## Scope

- Practical guidance: what to publish, what not to, and where to put access control (VPN, identity-aware proxy, provider policy).
- Link to DOC-12 for the reasoning.

## Out of scope

- CSP and origin mechanics (DOC-12).

## Primary sources

- [Specification §7 Markdown trust boundary, §18 viewer access](../../specification.md), [TD1](../technical-design/TD1-site-viewer-access.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)

## Acceptance criteria

- [ ] `ja/access-and-trust.html` and `en/access-and-trust.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.
