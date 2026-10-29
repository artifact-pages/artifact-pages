# A site's own HTML overview should be its front page, with the section links in the top bar

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web / site home

## Problem

The site home ([ISSUE-107](ISSUE-107-site-home-overview-files-preview-tabs.md)) only accepted a Markdown introduction (`README.md`, else `index.md`). A site whose front page is an HTML document (the docs site publishes one) could not use it as the Overview: the root `index.html` stayed an ordinary listed document, and `README.md` was listed beside it. Even a Markdown introduction sat under the tool-generated site header and a bar naming the file, so an author page with its own background colour never looked natural.

Owner decision (2026-10-28/29): the site's own HTML overview page is the site's front page, and the root `README.md`/`index.md`/`index.html` that serves as the introduction is not listed again. Layout "C2" was chosen over "C1" because the page's own background colour must reach the top bar: the section links move into the top bar, and Overview is simply the introduction page displayed like any opened page.

## Expected outcome

The site root's introduction is chosen like a folder's index page and is shown on Overview exactly as the reader shows that document at its own URL. The Overview / Files / Previews links and the site search live in the top bar. Files and Previews keep the compact site header.

## Acceptance criteria

- [x] The root introduction uses the folder index names and precedence: `README.md`, `index.md`, `index.html`, `index.htm` (case-insensitive; code-point order of the path among several). The chosen file is the introduction everywhere: Overview shows it, Files does not list it, Browse folds it out (the [ISSUE-128](ISSUE-128-root-readme-listed-in-browse.md) rule with four names). A root `index.html` that was not chosen stays an ordinary listed document.
- [x] On the site home (Overview, Files, Previews) the section links are in the top bar with the same hrefs, `nav aria-label="Site sections"`, `aria-current="page"`, the Previews count, and no Overview without an introduction. The in-page section row and the in-page "Search this site" button are gone; the top bar's search entry is the site search (scoped palette, focus returns to it). Off the site home the top bar has no section links.
- [x] Overview has no site header and no bar naming the file. The stage shows the introduction as the reader shows that document at its own URL (HTML in the artifact frame, Markdown via the Markdown renderer), with Contents and Details and the same top-bar page actions. The address stays `/:site`; copy link copies the site link.
- [x] Files and Previews show the compact site header (mark, title, `/id`, description, "N pages · Updated <date>") followed directly by their content.
- [x] Up to 620 px the top bar keeps its first row (sidebar button, site title, search, more) and the section links form a second row of the same bar (same background, bottom border and sticky header), left-aligned, all visible, never in a menu. The site title is not truncated for them; no horizontal overflow at 390 px; the page starts below the header.
- [x] Unchanged: history entries per section, Back/Forward restoring the section, `?section=files`, invalid `section` correction, an introduction that disappears falling back to Files, empty sites, standalone `/:site/_previews` before the index arrives, the shared preview-count load.
- [x] Unit tests (directory and tree) and Playwright tests cover the above; stories no longer show the old layout.

## Notes

Supersedes the Markdown-only introduction rule and the in-page section row of [ISSUE-107](ISSUE-107-site-home-overview-files-preview-tabs.md), and the four-name limit of [ISSUE-128](ISSUE-128-root-readme-listed-in-browse.md). Specification: `docs/specification.md` § Site home.

Open points for the owner: Overview's scroll position is the document's own (the reader does not restore it on Back); "Recently updated" in Files and the page count still include the introduction.

Released in web v0.4.9 (#236) and deployed to production on 2026-10-29 (admin #37).
