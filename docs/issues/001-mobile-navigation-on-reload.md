# Mobile navigation covers content after reload

- Status: Open
- Priority: P1
- Area: Mobile workspace navigation

## Problem

On a narrow viewport, the expanded sidebar becomes an overlay that covers most of the page. A direct load or reload opens that overlay even after the user closed it, delaying access to the artifact. Switching sites can also leave the destination page covered.

## Evidence and reproduction

1. Set the viewport to approximately 390 px wide and open `/sre/reports/latency-retrospective.md`.
2. Close the navigation overlay, then reload the page.
3. The overlay opens again over the document. The same covered state was observed after switching from SRE to HTML Showcase.

## Expected outcome

The artifact or site home is visible on arrival. Navigation opens when the user requests it and closes after choosing a destination on mobile.

## Acceptance criteria

- [ ] Direct loading and reloading an artifact at a narrow viewport show its content without an open navigation overlay.
- [ ] Switching sites on mobile shows the destination page without an open navigation overlay.
- [ ] Opening the navigation manually and choosing an artifact closes it after navigation.
