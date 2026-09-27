# Site switcher initially selects another site

- Status: Done
- Priority: P2
- Area: Site switcher command palette

## Problem

Opening the site switcher while viewing SRE initially selects Frontend, the first listed site. Pressing Enter before deliberately moving the selection can switch sites unexpectedly.

## Evidence and reproduction

1. Open `/sre` or an artifact beneath it.
2. Select the current site name in the sidebar or mobile rail.
3. The palette opens with `@` and Frontend selected, although SRE is the current site.

## Expected outcome

The initial selection does not make an accidental cross-site change likely.

## Acceptance criteria

- [x] Opening the switcher from a site either selects the current site or has no actionable default selection.
- [x] Typing a site query selects a matching result predictably.
- [x] Keyboard and touch selection lead to the same destination.

## Verification

- `npm run build`
- Playwright: empty site switcher, query selection by Enter, and the same query selection by click
