# Secondary text and controls lack contrast

- Status: Open
- Priority: P2
- Area: Workspace visual design

## Problem

In the dark theme, dates, file paths, section labels, empty-result guidance, and top-bar controls appear very faint. The light theme also uses faint secondary text. These elements carry navigation and provenance information, so their low visibility makes scanning and recovery harder.

## Evidence and reproduction

1. Open `/sre` in the dark theme and compare artifact titles with their paths, dates, sidebar labels, and toolbar controls.
2. Search for a query with no matches and inspect the recovery guidance.
3. Switch to the light theme and compare the same secondary information.

This is a visual observation from the desktop and mobile review; contrast ratios were not measured.

## Expected outcome

Secondary information remains readable in both themes, and available controls are visibly distinct from disabled controls.

## Acceptance criteria

- [ ] Paths, dates, section labels, and empty-state guidance remain legible in both themes at normal text size.
- [ ] Enabled toolbar actions are visibly distinguishable from disabled actions without relying on hover.
- [ ] Review both themes at desktop and narrow viewport widths.
