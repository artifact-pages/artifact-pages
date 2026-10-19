# Reading context and source provenance stay hidden behind separate controls

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web / reader context, Contents and Details

## Problem

Contents and Details provide useful reading context, but the current reader exposes them through separately opened panels. At widths where the document, left navigation and contextual information could coexist comfortably, readers must still discover and open those controls. This hides both the structure of the document and its provenance: source repository/ref, last committer and update date.

The source information is part of the product value: readers can understand where a document came from, follow its source to GitHub, investigate context/history there, and use the repository's existing contribution workflow. A last committer is not necessarily the document owner or contact person. These fields do not establish correctness or freshness by themselves.

## Evidence and reproduction

1. Owner supplied a screenshot of the existing Details popover, showing Last committed by, Updated, Source and branch, on 2026-10-17. A second screenshot illustrated a reading layout with a persistent right column and a table of contents; it is inspiration, not an instruction to copy its profile/social UI.
2. `web/src/components/ArtifactWorkspace.tsx` derives `tocOpen` and `detailsOpen` from a single `activePanel` and exposes separate Contents/Details toggles. Inspect the latest implementation before designing the replacement.
3. The owner requested a responsive right sidebar: show the current Contents and Details information when enough width is available, and collapse it on narrower screens. The exact breakpoint and layout have not been chosen or tested.

## Expected outcome and owner direction

Readers on sufficiently wide screens can see the document's headings and source context alongside its content. Narrower screens retain comfortable reading width and can explicitly open the same contextual information. This is a design-first backlog item for Claude, not an already approved visual specification.

**Order:** complete design, implementation and verification of this reader change before the official documentation rewrite/screenshots and feature descriptions are finalized. Documentation information-architecture discussion can continue. Coordinate with ISSUE-107's site-home work; neither issue authorizes a release or deploy.

## Design decision (2026-10-17)

- **Layout.** Variant D, chosen by the owner from the concept page: a 248 px right column with Details on top and Contents below. On a Markdown page Details scrolls away with the document and Contents sticks (about 8 px from the top of the reading pane); a heading list taller than the pane scrolls on its own. An HTML page scrolls inside its frame, so the column scrolls on its own (Details, then Contents, which sticks within the column). Publisher HTML is not changed or injected into.
- **Breakpoint.** 1200 px of viewport width. Rationale: the 248 px column plus the expanded 252 px sidebar leave at least about 700 px for the document. Browser zoom counts as a change in viewport width.
- **Visibility.** Automatic. There is no user toggle and no stored preference.
- **Scope.** Only a site's document page (Markdown or HTML) at 1200 px or more. Not site home, folder or directory pages (including a folder's index body), search results, not-found and error states, or preview pages (ISSUE-109).
- **Below 1200 px.** Unchanged (ISSUE-080 chrome): the Contents and Details buttons and the overlay panel. At 1200 px or more the buttons are not shown.
- **Focus.** The Contents and Details shortcut and palette commands move focus to that part of the column (the current entry or the first one for Contents; the empty message when there are no headings). Narrow to wide with the overlay open: the panel closes, and focus that was inside it (or on its button) moves to the matching part of the column. Wide to narrow with focus in the column: focus moves to the matching context-bar button (the More menu button on the narrowest chrome). Activating a heading entry keeps focus on that entry. Focus is never lost to `body`.
- **Current heading.** Contents marks the heading being read with `aria-current="location"`; for HTML this is best effort and silent when the frame cannot be read.

## Scope and design brief for Claude

- Design a right sidebar using the existing product's typography, spacing, colors and light/dark themes. Decide how Contents and Details coexist, including their order, density and long-content scrolling. Do not copy the reference site's author profile, follow/donation controls or social features.
- Choose a width rule based on the space required by the left sidebar, readable document body and right sidebar. Show sufficiently wide and narrow states in inspectable concepts before implementation. Consider the left sidebar both expanded and collapsed, as well as browser zoom.
- On narrower screens collapse the persistent right column and keep Contents/Details reachable through an appropriate existing or redesigned control. Preserve the narrow-reader goals of completed ISSUE-080; this is a new wide-screen context requirement, not a reopening of its verified acceptance criteria.
- Resolve automatic visibility versus user toggling, any preference persistence, focus behavior when resizing, and how transient controls relate to the persistent column. Those choices are not settled by the owner's request.
- Preserve heading navigation and accurate Details values. Describe the source action as returning to/opening **GitHub**, rather than promising generic Git-provider support. Do not promise file-, commit- or PR-specific links beyond what actual metadata and link generation support; do not fabricate contact/ownership information.
- Cover documents with no indexed headings, missing optional provenance, long titles/headings/repository names, Markdown and HTML artifacts, and preview documents. Reuse existing indexed heading navigation and HTML isolation/preview bridges; do not inject reader UI into publisher HTML.
- Decide where the column applies. The request is about document reading, not a mandate to add an empty right column to site home, folder pages, search results or error screens. Coordinate with ISSUE-107 to avoid reducing its root-page content width accidentally.

Relevant starting points: `web/src/components/ArtifactWorkspace.tsx`, its current Contents/Details components, `PreviewDocumentPage.tsx`, `web/src/styles.css` and existing responsive/heading-navigation browser stories/tests. Confirm current main and applicable AGENTS.md before creating an isolated worktree. Follow normal Claude-led design, directory implementation and fresh cross-review rules; claim this issue only when work starts.

No public documentation page rewrite, external service integration, authorship/ownership system, new metadata contract, CLI/Actions/Terraform changes, production operation or release is included. If a metadata or contract change proves necessary, surface it as a separate design decision rather than assuming it is authorized.

## Acceptance criteria

- [x] Claude presents inspectable designs for wide and narrow reading layouts, and records the chosen layout, breakpoint rationale and toggle/focus behavior before implementation.
- [x] At sufficient width, existing Contents and Details information is available in a persistent right column while the main document remains comfortably readable.
- [x] Below the chosen width threshold, the column collapses and both information groups remain explicitly accessible. Resizing/zooming and left-sidebar toggling do not create overlapping chrome, lost focus or horizontal page overflow.
- [x] Heading links still navigate to the intended Markdown/HTML heading; provenance values and GitHub links remain accurate. No last-committer-as-owner claim or synthetic provenance is introduced.
- [x] Missing headings/provenance and long labels produce useful, uncluttered states. Applicable preview, empty/error and non-document surfaces follow the recorded scope decisions.
- [x] Keyboard navigation, accessible names, focus order/return, long-column scrolling, light/dark and representative narrow/wide widths are verified in the actual product.
- [x] Relevant stories/regressions and applicable web/browser checks pass, fresh cross-review is complete, and this item is resolved before final documentation screenshots and reader-feature copy are produced.

## Related work

- [ISSUE-109](ISSUE-109-preview-reading-context-and-entry.md): subsequent preview experience redesign; establish this sidebar pattern first, then apply it to richer preview metadata and app-mediated reading.

- [ISSUE-107](ISSUE-107-site-home-overview-files-preview-tabs.md): selected site-root navigation; coordinate common chrome while keeping document context separate.
- [ISSUE-080](ISSUE-080-narrow-screen-chrome-and-scroll-cues.md): completed narrow-reader chrome work; preserve its reading-space goals.

## Verification

Implemented in `web/` (2026-10-17, Claude): `ReaderContextColumn.tsx`, `useCurrentHeading.ts`, the `aside` slot of `MarkdownArtifact`, `ArtifactWorkspace.tsx` and `styles.css`. The concept variants are on the `claude-issue-108-concepts` branch.

- `npm run build` and `npm run test:web-unit` pass. Storybook builds with the new stories `Wide reader · Markdown column` (light and dark) and `Wide reader · HTML column`.
- Full e2e on compose project `claude-issue-108`, `CI=1` (one retry allowed): 248 passed, none flaky. The new tests are in `web/e2e/local-serving.spec.ts`, describe `reader context column (ISSUE-108)` (20 tests): the column at 1440 px for Markdown and HTML; Details scrolling away while Contents stays; a heading list taller than the pane scrolling on its own; the HTML column scrolling on its own; the current heading following the scroll (Markdown and HTML) and staying visible in the list; heading activation (fragment, one history step, focus kept on the entry); buttons and panels below 1200 px; both resize focus transitions; shortcut and palette focus; no-headings and missing-provenance documents; long labels; no horizontal overflow at 1200 px expanded and 1280 px collapsed; the match navigator beside the column; no column on site home, folder, search, preview and not-found routes.
- Existing tests whose premise changed (they open the overlay panels or use the toolbar buttons) now run at 1100 px: palette Details command, heading ID conformance, HTML heading navigation, dismiss and reopen, jump-keeps-panel, stale jump check, multi-file namespace, Markdown render safety, Markdown gallery, site-home actions, and the ISSUE-080 wide toolbar test.
- Screenshots (uncommitted, `.local/issue-108/`): 1440 px light and dark, 1280 px with the sidebar collapsed, 1100 px.

Known limits: the current heading is the last one whose top has passed a reading line near the top of the pane, so at the very end of a document an entry that cannot reach that line (the last short sections) is not marked until the reader scrolls to it. HTML marking is best effort and silent when the frame cannot be read. Review fixes (Luna cross-review): focus now follows the reader from the narrow More menu trigger (or a panel opened from it) into the matching column part, Contents when no panel was open; the column is not shown while a Markdown document or an HTML body has failed to load (both have e2e tests, and the column returns after a retry).

Owner check (2026-10-19): production web 0.4.0 (https://artifact-pages.dev, admin App deploy run 39256651234) on macOS 26.5.1, Safari 26.5, VoiceOver; zoom also on the owner's iPhone (model and iOS version not recorded). The "Reading context" landmark appears in the VoiceOver rotor; Tab order runs from Details links into the Contents headings and activating a heading moves to it; Details scrolls away while Contents stays; light and dark are legible. Browser zoom at 125/150/175 % collapses the column into the Contents/Details buttons without overlap or horizontal scrolling, and pinch zoom on the iPhone shows no breakage. No issues found. This is not the ISSUE-080/T24 real-phone check, which stays open. Together with the e2e coverage above (narrow-panel focus return, the HTML column), and the Luna cross-review (run locally, so it left no PR comments) whose fixes landed as the review-fix commits squashed into #162, the remaining criteria are met.
