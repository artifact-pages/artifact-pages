# Reading context and source provenance stay hidden behind separate controls

- Status: Open
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

- [ ] Claude presents inspectable designs for wide and narrow reading layouts, and records the chosen layout, breakpoint rationale and toggle/focus behavior before implementation.
- [ ] At sufficient width, existing Contents and Details information is available in a persistent right column while the main document remains comfortably readable.
- [ ] Below the chosen width threshold, the column collapses and both information groups remain explicitly accessible. Resizing/zooming and left-sidebar toggling do not create overlapping chrome, lost focus or horizontal page overflow.
- [ ] Heading links still navigate to the intended Markdown/HTML heading; provenance values and GitHub links remain accurate. No last-committer-as-owner claim or synthetic provenance is introduced.
- [ ] Missing headings/provenance and long labels produce useful, uncluttered states. Applicable preview, empty/error and non-document surfaces follow the recorded scope decisions.
- [ ] Keyboard navigation, accessible names, focus order/return, long-column scrolling, light/dark and representative narrow/wide widths are verified in the actual product.
- [ ] Relevant stories/regressions and applicable web/browser checks pass, fresh cross-review is complete, and this item is resolved before final documentation screenshots and reader-feature copy are produced.

## Related work

- [ISSUE-107](ISSUE-107-site-home-overview-files-preview-tabs.md): selected site-root navigation; coordinate common chrome while keeping document context separate.
- [ISSUE-080](ISSUE-080-narrow-screen-chrome-and-scroll-cues.md): completed narrow-reader chrome work; preserve its reading-space goals.

This issue is unimplemented. No performance, breakpoint or device behavior has been verified merely by filing it.
