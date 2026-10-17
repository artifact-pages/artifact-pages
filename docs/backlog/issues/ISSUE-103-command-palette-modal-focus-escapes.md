# Keyboard focus escapes the command palette while its modal stays open

- Status: Open
- Priority: P2
- Area: Reader / command palette accessibility
- Implementer: Claude
- Source: hands-on project review 2026-10-15, N3; production web 0.3.2 and monorepo `86841bb1`
- Related: [ISSUE-104](ISSUE-104-search-selection-is-not-associated-with-input.md), [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md)

## Problem

The command palette declares itself modal, but keyboard focus can move behind its backdrop. A keyboard user can be operating a background link while the visible interaction remains the search dialog.

## Evidence and reproduction

1. On the production Guide home (`/guide`), activate “Jump to a page…”. The review exercised normal and 390 px layouts; the captured escape occurred at 390×844.
2. With the palette input focused, press Shift+Tab.
3. The background “Getting started” link receives focus while the palette remains visible.
4. DOM inspection returned `dialogOpen: true`, `focusedTag: 'A'`, `inDialog: false`.
5. `web/src/components/CommandPalette.tsx` focuses its input on mount and sets `role="dialog"` / `aria-modal="true"`, but does not confine Tab navigation or make the background inert.

Supplementary workspace evidence: `reviews/2026-10-15-project/palette-focus-escape.jpg` and `palette-focus-escape.json`.

## Expected outcome

While the palette is modal, keyboard focus stays within it. Dismissing it or choosing a destination restores or moves focus to the intended next surface.

## Acceptance criteria

- [ ] Tab and Shift+Tab cycle within the palette for both site-list and in-site entry points.
- [ ] Background controls cannot receive keyboard focus while the modal is open.
- [ ] Escape and Close return focus to the opening control when it still exists; selecting a destination preserves the intended page/heading focus handoff.
- [ ] Empty results, dynamically changing results and a palette with only commands remain operable.
- [ ] A browser regression checks actual focused elements, not just the dialog's visible state or ARIA attributes.
