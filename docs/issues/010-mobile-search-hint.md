# Mobile search advertises a desktop shortcut

- Status: Open
- Priority: P3
- Area: Search entry points on touch screens

## Problem

At a phone-sized viewport, search controls still prominently display `⌘ K`. The command shortcut is useful on a keyboard but does not tell a touch user where to tap or what scope the search covers.

## Evidence and reproduction

1. Set the viewport to approximately 390 px wide and open `/` or `/sre`.
2. Inspect the search field and its `⌘ K` hint. The collapsed workspace also exposes a magnifying-glass icon in the rail.

## Expected outcome

Touch users see a clear search action and scope; keyboard shortcuts remain available when a keyboard is relevant.

## Acceptance criteria

- [ ] Phone-sized layouts favor a touch-oriented label or affordance over a visible desktop shortcut chip.
- [ ] The collapsed rail's search control has a clear accessible name and opens the expected search surface.
- [ ] Desktop keyboard shortcuts remain available and discoverable on desktop.
