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

(empty)
