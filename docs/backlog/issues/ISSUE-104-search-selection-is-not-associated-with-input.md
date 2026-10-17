# Arrow-selected search results are not associated with the focused input

- Status: Open
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

- [ ] In both search surfaces, arrows expose the current candidate's identity and selection through a valid accessible focus model.
- [ ] A main screen-reader path verifies that the selected candidate and Enter destination can be followed; record browser and assistive technology used.
- [ ] Query changes, stale/loading results and empty lists do not retain an invalid active-result reference.
- [ ] IME confirmation, Enter, Escape and the palette's page/heading navigation continue to work.
- [ ] Regression checks cover the accessible relationship as well as visual highlighting.
