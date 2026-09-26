# Secondary text and controls lack contrast

- Status: Done
- Priority: P2
- Area: Workspace visual design

## Problem

In the dark theme, dates, file paths, section labels, empty-result guidance, and top-bar controls appear very faint. The light theme also uses faint secondary text. These elements carry navigation and provenance information, so their low visibility makes scanning and recovery harder.

## Evidence and reproduction

1. Open `/sre` in the dark theme and compare artifact titles with their paths, dates, sidebar labels, and toolbar controls.
2. Search for a query with no matches and inspect the recovery guidance.
3. Switch to the light theme and compare the same secondary information.

The desktop and narrow-screen review found low-contrast metadata in both themes. The updated tertiary text colors measure 4.56:1 on the light sidebar, 5.49:1 on light content, 5.30:1 on the dark shell, and 4.93:1 on dark content. Enabled icon actions now use the secondary text color; disabled controls retain their reduced opacity.

## Expected outcome

Secondary information remains readable in both themes, and available controls are visibly distinct from disabled controls.

## Acceptance criteria

- [x] Paths, dates, section labels, and empty-state guidance remain legible in both themes at normal text size.
- [x] Enabled toolbar actions are visibly distinguishable from disabled actions without relying on hover.
- [x] Review both themes at desktop and narrow viewport widths.

## Verification

- `npm run build`
- Playwright: “Markdown retrospective stays readable on narrow screens and supports theme styling” and “the selected theme is offered in the menu and reaches adaptive artifact iframes”
- Visual review in the in-app browser at desktop and 390px-wide viewports, in light and dark themes
