# Arrow-selected search results are not associated with the focused input

- Status: In progress
- Assignee: Claude
- Priority: P2
- Area: Reader / palette and full-text search accessibility
- Implementer: Claude
- Source: hands-on project review 2026-10-15, N4; production web 0.3.2 and monorepo `86841bb1`
- Related: [ISSUE-103](ISSUE-103-command-palette-modal-focus-escapes.md), [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md)

## Problem

Arrow keys change the visibly selected result while DOM focus remains in the input, without exposing the relationship needed to track that virtual focus. Enter can open the visually selected page, but assistive technology is not given an associated active result.

## Evidence and reproduction

1. On `/guide`, open the palette, type `Cloudflare`, then press ArrowDown.
2. The selected option changes to “Start with Cloudflare”, while the active element remains INPUT. Its `role`, `aria-controls` and `aria-activedescendant` are absent; the selected option has no referenced ID.
3. Open full-text search for the same term. After results load, press ArrowDown in the search input. A result gains visual `data-active`, while focus stays in INPUT with no `aria-controls` or `aria-activedescendant`.
4. Enter successfully opened the selected result in the review. The defect is the missing accessible selection relationship, not a failure of the ordinary Enter action.
5. Source: `web/src/components/CommandPalette.tsx` input/options and key handler; `web/src/components/SearchResultsPage.tsx` `handleKeyDown`, input and result list.

Supplementary workspace evidence: `palette-a11y.json` and `search-a11y.json` under `reviews/2026-10-15-project/`. These are DOM/keyboard observations; a real screen-reader session was not performed.

## Expected outcome

Keyboard selection has an accessible, trackable active result, through an appropriate input/result relationship or actual result focus. The implementation should use a coherent interaction pattern rather than adding unrelated attributes.

## Acceptance criteria

- [x] In both search surfaces, arrows expose the current candidate's identity and selection through a valid accessible focus model.
- [ ] A main screen-reader path verifies that the selected candidate and Enter destination can be followed; record browser and assistive technology used.
- [x] Query changes, stale/loading results and empty lists do not retain an invalid active-result reference.
- [x] IME confirmation, Enter, Escape and the palette's page/heading navigation continue to work.
- [x] Regression checks cover the accessible relationship as well as visual highlighting.

## Verification

- Palette (`CommandPalette.tsx`): the input is a WAI-ARIA combobox (`role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`) over a listbox with identified options and labelled section groups. The listbox is absent when there are no entries, so `aria-activedescendant` and `aria-controls` are never left pointing at a missing id.
- Results page (`SearchResultsPage.tsx`): results are links, so ArrowDown in the field moves real focus to the first link, ArrowUp/ArrowDown walk the links, ArrowUp on the first link and Escape return to the field, Enter in the field only commits the query, and `aria-current` is no longer used for selection.
- e2e (`local-serving.spec.ts`): the combobox test checks `aria-activedescendant`, `aria-selected`, and the empty state; the results-page tests check `document.activeElement`. Existing tests changed: the palette field is now located with `getByRole('combobox', …)` instead of `textbox`; `ranked results are a list of links that open from the keyboard` and `arrow keys … when excerpts are shown` no longer expect virtual selection or Enter-opens-active-hit in the field, and assert focus on the links and native Enter on a focused link instead.
- Results: `npm run build` and `npm run test:web-unit` pass; full e2e 227 passed.
- Open: the screen-reader criterion (a main screen-reader path that follows the selected candidate and Enter destination, recording browser and assistive technology) awaits a manual VoiceOver session by the owner. The ticket stays In progress until then.
