# DOC-02 — Guide: overview page

- Status: In progress
- Site: `guide`
- Page: `ja/what-is-git-artifact-pages.html`, `en/what-is-git-artifact-pages.html`
- Audience: Everyone; first page a new visitor reads
- Depends on: DOC-01

## Purpose

Introduce what Git Artifact Pages is and walk through the four roles (deploy the app, register sites, publish from each repository, read) with the scroll-driven diagram, then show a team site's home page and the `@` site switch.

## Scope

- Hero, three promises, the four-step story with the growing diagram, and the example team site with the command palette.
- Point readers to the next guide pages and to the `architecture` site once those exist.

## Out of scope

- Detailed procedures (DOC-03, DOC-04) and configuration reference (DOC-06).

## Primary sources

- [Specification §1–§3, §8](../../specification.md), [§22 deployment configuration](../../specification.md)
- `artifact-pages app deploy|registry register|site publish --help`

## Acceptance criteria

- [ ] `ja/what-is-git-artifact-pages.html` and `en/what-is-git-artifact-pages.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [ ] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [ ] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [ ] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Notes

- A draft exists in both languages (currently at the top-level `ja/` and `en/` sites) and is under owner review.
- Replace `.artifact-pages.yaml` with `artifact-pages.yaml` if the in-progress default-config rename lands.
- Add previous/next links once DOC-03 exists.
