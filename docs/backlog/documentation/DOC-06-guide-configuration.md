# DOC-06 — Guide: configuration

- Status: Open
- Site: `guide`
- Page: `ja/configuration.html`, `en/configuration.html`
- Audience: Admins maintaining a deployment
- Depends on: DOC-03

## Purpose

Document the deployment config: file location and precedence, `schemaVersion`, `provider` blocks, the `sites` mapping, layering, and remote `github://` locators.

## Scope

- Config selection precedence and the default filename.
- Provider blocks for `local`, AWS, and Cloudflare at the level needed to choose and fill them; credentials never go in YAML.
- `sites` as the complete desired set and what removing a site does.

## Out of scope

- Terraform and account provisioning details beyond linking the operator guides.

## Primary sources

- [Specification §22](../../specification.md), [T10](../technical-design/T10-config-location.md), [T12](../technical-design/T12-cloudflare-production-mapping.md)
- [Cloudflare deployment](../../guides/cloudflare-deployment.md), [Local edge object storage](../../guides/local-edge-object-storage.md)

## Acceptance criteria

- [ ] `ja/configuration.html` and `en/configuration.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- Wait for the default-config filename change to settle before drafting.

## Dependency on the release shape

This page refers to how components are obtained and pinned. Draft it after the release-shape decision recorded in [DOC-03](DOC-03-guide-getting-started.md#blocker-2026-10-01).
