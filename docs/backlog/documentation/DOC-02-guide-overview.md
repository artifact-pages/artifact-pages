# DOC-02 — Guide: overview page

- Status: Done
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

- [x] `ja/what-is-git-artifact-pages.html` and `en/what-is-git-artifact-pages.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [x] The owner reviewed and approved the page.

## Verification (2026-10-01)

- Owner approved the page content on 2026-10-01; follow-up fixes: config name `artifact-pages.yaml` (the default-config rename is implemented), Japanese section and step labels, app-accurate sidebar tree in both mocks, the example site home shown before the palette opens, theme copied from the reader app before first paint, softer CI wording.
- Local reader with the app forced dark and the OS light: the page's `data-theme` is `dark` at DOMContentLoaded. The example palette is closed at 0.9s and open with six sites at 3.1s. No page errors.
- `ja` and `en` render at 1440px light and 400px dark without horizontal scrolling; `npm run docs:check-assets` passes; `site publish --site guide` synced.

## Notes

- Add previous/next links once DOC-03 exists.
