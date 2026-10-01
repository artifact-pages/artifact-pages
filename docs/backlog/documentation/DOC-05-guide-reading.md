# DOC-05 — Guide: reading

- Status: In progress
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

- [x] `ja/reading.html` and `en/reading.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-01, awaiting owner review)

- Facts checked against specification §4, §7, §8 and the app: palette commands and shortcuts (`ArtifactWorkspace.tsx`), scopes and prefixes (`CommandPalette.tsx`), recent reads limit of 20 per site (`recent-reads.ts`), Recently updated from 7 artifacts (`navigation-sections.ts`).
- The index records the page titles and all eight headings; the reader's Contents panel lists them.
- In the local reader: the sample palette lists `Guide` and the illustrative site on `@`; its tree shows `en` and `ja` with the current page selected; previous/next links move between the overview and this page.
- `ja` and `en` render in light and dark, and at 400px without page-level horizontal scrolling (tables scroll inside their frame). No page errors.
- The overview page now links to this page as Next, and its "how it works" heading has an id so it appears in Contents.
