# T24 — Pre-launch browser and keyboard matrix

- Status: Open
- Phase: Pre-launch
- Scope: the production web reader on real browsers, a real phone and keyboard-only use
- Implementer: Claude
- Source: public-launch review 2026-10-13, section 6

## Contract to prove

The reader works for a first-time visitor across the browsers and input methods the launch claims to support, and every failure state shows the current location and a way to recover. Record results, not a service-level objective.

The Playwright configuration (`web/playwright.config.ts:15`) runs Chromium only, so none of the following is covered by CI.

## Exit criteria

- [ ] Chrome, Safari and Firefox on desktop, plus one real phone, are exercised on the production Guide.
- [ ] Keyboard-only use covers site switching, the palette, the sidebar, the page body, Contents and search results, with focus returning correctly and the iframe boundary behaving.
- [ ] IME input, browser zoom, long titles, long tables, reduced motion and the main screen-reader paths are checked.
- [ ] Failure states are checked: offline, slow metadata, a broken index, a stale generation, and storage or clipboard unavailable. Each shows the current location and a recovery path.
- [ ] A first-time visitor can find what to install, where to start and the current version.

## Evidence

### Partial hands-on pass, 2026-10-15

At monorepo `86841bb1` and production web 0.3.2, the Codex in-app Chromium browser exercised site selection, a Japanese HTML page, palette search, full-text search for R2, ja/ folder filtering, result-to-heading navigation, browser Back, Contents and light/dark themes. At 390×844 the Japanese page's document width and scroll width were both 389 px; no page-level horizontal overflow was observed in that sampled page. This is viewport emulation, not a real-phone result.

Confirmed defects now have product issues: loading deadlines [ISSUE-101](../issues/ISSUE-101-registry-and-site-index-loads-have-no-deadline.md), retry [ISSUE-102](../issues/ISSUE-102-load-errors-offer-no-retry-action.md), modal focus [ISSUE-103](../issues/ISSUE-103-command-palette-modal-focus-escapes.md), accessible search selection [ISSUE-104](../issues/ISSUE-104-search-selection-is-not-associated-with-input.md), and known-HTML failure guidance [ISSUE-106](../issues/ISSUE-106-known-html-failure-has-no-reader-guidance.md).

Safari, Firefox, a real phone, a real screen reader and real IME were not exercised. The review's 223 passing Chromium E2E tests are supporting evidence, not completion of this matrix. All exit criteria remain unchecked. Public documentation content/structure is excluded from the current review triage by owner decision 2026-10-15.

Supplementary workspace report and captures: `reviews/2026-10-15-project/`.
