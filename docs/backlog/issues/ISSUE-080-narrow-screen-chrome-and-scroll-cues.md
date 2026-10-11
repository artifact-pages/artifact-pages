# On narrow screens the permanent rail and two-row toolbar take reading space, and wide tables and code scroll without a cue

- Status: Open
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

## Acceptance criteria

- [ ] At 390 px the permanent rail is replaced by a lighter affordance (for example one top-bar control for the drawer) so the document uses the full width when the drawer is closed; the rail remains at wider widths. The exact pattern is decided in the issue.
- [ ] The toolbar fits one row at 390 px (overflow actions move into the existing menu), or its second row is justified in the issue; icon-only controls keep accessible names.
- [ ] Scrollable regions the reader owns (Markdown tables, code blocks) show an edge fade or equivalent cue when content is clipped; whether the reader injects a cue into HTML artifact frames is decided and recorded.
- [ ] Verified by a Playwright case at 390 px (viewport emulation) and then checked once on a real phone or device emulator; record which.
- [ ] No horizontal page scroll at 390 px (existing behavior kept).
