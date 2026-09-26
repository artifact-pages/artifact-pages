# Artifact title and route to site home are hard to find

- Status: Done
- Priority: P2
- Area: Artifact workspace header

## Problem

After opening an artifact, the workspace header primarily shows its source-relative path. The artifact title is not consistently visible in the shell, and the path truncates on mobile. The site name opens a site switcher rather than giving an obvious route back to the current site's home.

## Evidence and reproduction

1. Open `/sre/reports/latency-retrospective.md`, whose Markdown starts with a callout rather than an H1.
2. Inspect the workspace header and look for the artifact's display title and a link to `/sre`.
3. Repeat at approximately 390 px width; the path is truncated and toolbar icons occupy most of the header.

## Expected outcome

A reader can recognize the current artifact and return to its site home without recalling a command or editing the URL.

## Acceptance criteria

- [x] The artifact display title is available as a clear current-page label, including when the artifact body has no H1.
- [x] The current site has an obvious home navigation control distinct from switching sites.
- [x] Narrow layouts preserve a recognizable current-page label and accessible control names.

## Verification

- `npm run build`
- Playwright: “artifact title and site home navigation stay clear on narrow screens”
- Visual review in the in-app browser at desktop and 390px-wide viewports; the home action navigates to `/sre`.
