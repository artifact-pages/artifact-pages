# DOC-03 — Guide: getting started

- Status: Open
- Site: `guide`
- Page: `ja/getting-started.html`, `en/getting-started.html`
- Audience: Admins setting up a deployment for the first time
- Depends on: DOC-02

## Purpose

Take an admin from nothing to a first readable site: choose a delivery target, deploy the app, register sites, publish once, and open it.

## Scope

- Prerequisites and the admin repository's role.
- A local-first path (provider `local`) that can be tried without a cloud account, then where the cloud paths diverge.
- `app deploy`, `registry register`, first `site publish`, and how to confirm the result in the reader.

## Out of scope

- Provider-specific account setup beyond pointing to DOC-06 and the operator guides.

## Primary sources

- [Specification §11 Registry, §13 Local reference, §22](../../specification.md)
- [Clean-room adoption](../../guides/clean-room-adoption.md), [Local registered sites](../../guides/local-registered-sites.md), [App bundle deployment](../../guides/app-bundle-deployment.md)

## Acceptance criteria

- [ ] `ja/getting-started.html` and `en/getting-started.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- Decide with the owner whether the local path or a cloud path is the primary walkthrough.
