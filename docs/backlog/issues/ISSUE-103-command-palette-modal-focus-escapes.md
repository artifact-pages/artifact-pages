# Keyboard focus escapes the command palette while its modal stays open

- Status: Done
- Assignee: Claude
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

- [x] Tab and Shift+Tab cycle within the palette for both site-list and in-site entry points.
- [x] Background controls cannot receive keyboard focus while the modal is open.
- [x] Escape and Close return focus to the opening control when it still exists; selecting a destination preserves the intended page/heading focus handoff.
- [x] Empty results, dynamically changing results and a palette with only commands remain operable.
- [x] A browser regression checks actual focused elements, not just the dialog's visible state or ARIA attributes.

## Verification

- `web/src/components/CommandPalette.tsx`: the dialog renders through a portal into `document.body`, `#root` is `inert` while it is open (previous value restored), Tab and Shift+Tab wrap between the input and the close button (result options are `tabIndex={-1}`), and Escape, the close button and a backdrop mousedown call `dismiss()`, which closes and then focuses the remembered opener on the next animation frame. Choosing an entry keeps the previous handoff. Callers' own return-focus code is unchanged.
- Browser regression (`web/e2e/local-serving.spec.ts`, `the site list palette keeps keyboard focus inside…` and `the in-site palette keeps keyboard focus inside…`): checks `document.activeElement` over 6 Tab and 6 Shift+Tab presses for the blank, no-results and `>` (commands) states, `#root.inert`, that focusing a background link leaves focus in the dialog, and that Escape and the close button return focus to the opener.
- Results: `npm run build` passes, `npm run test:web-unit` passes, full e2e 227 passed (nginx stack, Chromium).
