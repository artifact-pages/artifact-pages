# IMP-83 — Modal Contents focus and heading hand-off

- Status: In progress
- Assignee: Codex
- Scope: Web reader, UI/UX redesign slice S1

## Goal

Readers using temporary Contents below the persistent-column breakpoint can enter the panel, navigate by keyboard, dismiss to its trigger, or select a heading and continue reading at that heading.

## Accepted behavior

Owner agreed on 2026-10-24–25: keep the one-row header and existing panel location; make temporary Contents modal. Tab stays inside the panel. Escape, close, or a click outside returns focus to the invoking toolbar control (More on narrow screens). Selecting a heading always closes temporary Contents and moves focus to the destination. The wide persistent column remains visible and keeps focus on its entry.

The previous geometry-dependent Markdown keep-open behavior is replaced by this accepted contract in [specification §8](../../specification.md#right-sidebar).

## Scope

- Native modal Contents with explicit Tab cycling, outside dismissal, and focus hand-off.
- Remove delayed geometry checks that may interfere with a reopened panel.
- Preserve reading position on cancellation, HTML/Markdown fragment navigation, palette/shortcuts, and responsive column transitions.
- Keep Details' existing presentation in this slice; the header redesign, localization, folder presentation, search and previews are later slices.

## Acceptance criteria

- [x] More-menu, toolbar, shortcut and palette entry paths focus the temporary dialog.
- [x] Tab and Shift+Tab cycle inside Contents; Escape/close/outside restore its invoking control.
- [x] HTML and Markdown selection closes the dialog, updates the fragment and focuses the destination heading.
- [x] Reopening or navigation cancels pending destination focus.
- [x] Persistent-column behavior and reading position on dismissal are preserved.
- [ ] Build, web unit tests and relevant browser regressions pass; review evidence is recorded.

## Verification

Implemented in `codex-uiux-s1-focus`, based on `8d81196e` (2026-10-25), under the owner's standalone-session exception.

- Node 24.18.0: `npm run build`, `npm run test:web-unit` (273 tests), and `npm run build-storybook` pass.
- Full local nginx/Chromium E2E: 341/341 pass. After the final pending-focus cancellation guard on a switch to the persistent column, the final build passes all 52 Contents/context-column regression tests.
- Manual browser check at 390px: More → Contents focuses Close, Shift+Tab reaches the last entry, choosing Practice over prediction closes the dialog, updates both URLs to `#practice`, and focuses the HTML heading. The one-row header remains intact. Screenshot and detailed evidence live in the workspace review record `reviews/2026-10-24-frontend-uiux/S1-IMPLEMENTATION.md`.
- Self-review caught and fixed a Details toggle regression: opening the palette dismisses Contents, while retaining Details state for its toggle command. Existing Details tests pass.
- Independent cross review and PR CI remain pending; this item stays In progress until that review is recorded. No release or deployment is part of this item.
