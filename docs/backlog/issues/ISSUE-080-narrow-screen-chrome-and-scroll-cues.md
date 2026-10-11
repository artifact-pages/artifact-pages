# On narrow screens the permanent rail and two-row toolbar take reading space, and wide tables and code scroll without a cue

- Status: In progress
- Assignee: Claude
- Priority: P2
- Area: Reader shell at narrow widths (`web/src/styles.css`, `web/src/components/ArtifactWorkspace.tsx`, `MarkdownArtifact.tsx`)

## Problem

At phone width the reader keeps a 48 px icon rail beside the document and a header that wraps into a second row of icon buttons, so a large share of a small screen is chrome. Wide tables and code blocks scroll inside their wrappers (no horizontal page scroll), but nothing signals that more content is to the right.

## Evidence and reproduction

Limitation first: the window could not be made narrower than the host window, so the app was tested inside a 390 px wide iframe that embeds the real app. This exercises the real media queries but is not a real device (no touch, no browser chrome, no device pixel behavior). Treat measurements as approximate and re-check on a device.

1. At 390 px, open a document on `https://artifact-pages.dev/guide`. Observed: a 48 px rail (sidebar toggle, site mark, search) stays visible, leaving about 341 px for content; the sidebar opens as a 260 px drawer over the content (works, tree intact). The header wraps into a breadcrumb row and a row of six icon buttons with only "Pin" labeled; Contents and Details have `title` and accessible names but no visible labels. The two rows plus the rail use about 80 px of vertical space before content.
2. Source: at `max-width: 860px` the shell collapses to one column and `.app-shell.sidebar-collapsed` keeps a `48px` column (`styles.css:2528-2536`); the rail renders when the sidebar is closed (`ArtifactWorkspace.tsx:607-608`, `.collapsed-rail` at `styles.css:164`).
3. Tables (560 to 1062 px wide) show only the first columns; code blocks scroll horizontally. Markdown tables already get a "Scroll to see more columns →" hint (`MarkdownArtifact.tsx:355-376`). The sampled sites contain only HTML artifacts, whose tables and code live inside the artifact iframe; the reader cannot add a cue there without artifact cooperation or injection, which is out of scope unless decided. The Architecture "object map" on the Storage layout page is wider than the phone (content feedback for the docs repository, not filed here).

Not verified: Markdown artifacts at narrow width (none on the sampled sites); real-device behavior.

## Expected outcome

At narrow widths the document gets nearly the full width and height, navigation stays reachable, and scrollable regions are visibly scrollable.

## Owner decision (2026-10-11)

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-080 stories: variant B, a menu button with a single-row toolbar whose secondary actions (Contents, Details, Pin, Copy link, site home, all sites, theme) move into a More menu. Scroll cue: option 3, edge shadow plus the existing text hint, for Markdown tables and code blocks. The reader does not inject cues into HTML artifact frames.

## Acceptance criteria

- [x] At 390 px the permanent rail is replaced by a lighter affordance (for example one top-bar control for the drawer) so the document uses the full width when the drawer is closed; the rail remains at wider widths. Decided: a menu button opens the drawer.
- [x] The toolbar fits one row at 390 px (overflow actions move into the existing menu), with a menu button and a single row (decided); icon-only controls keep accessible names.
- [x] Scrollable regions the reader owns (Markdown tables, code blocks) show an edge shadow plus the existing hint when content is clipped (decided); no cues are injected into HTML artifact frames (decided).
- [ ] Verified by a Playwright case at 390 px (viewport emulation) and then checked once on a real phone or device emulator; record which.
- [x] No horizontal page scroll at 390 px (existing behavior kept).

## Resolution (2026-10-11)

- Implemented per the owner decision: at up to 620 px the rail is not rendered, a menu button opens the drawer, and the single-row header holds the path, a search button and a More menu (`ReaderMoreMenu.tsx`) with Contents, Details, Pin, Copy link, Open raw artifact, site home, All sites and the theme choices. Folder pages and the not-found view use the same bar; the skip link and the page text search chip are unchanged.
- Markdown tables and code blocks get an edge shadow per clipped side (`domain/scroll-edges.ts`, `.scroll-cue` in `styles.css`) plus the existing table hint; nothing is injected into HTML frames. Specification: Main pane section.
- Verification: unit tests in `web/src/domain/scroll-edges.test.mjs`; Playwright cases at 390 px (the "narrow chrome and scroll cues (ISSUE-080)" group and the updated narrow cases) use viewport emulation only. The one-time real phone or device-emulator check is still open (it keeps this item In progress). Stories: `Product/Workspace` (Narrow ...) and `Product/Markdown scroll cues`.
