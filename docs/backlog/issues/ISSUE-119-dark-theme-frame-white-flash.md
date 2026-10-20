# Dark theme: the artifact frame flashes white when a page opens

- Status: In progress
- Assignee: Claude
- Priority: P3
- Area: Web / reader artifact frame

## Problem

In the dark theme, moving to another HTML page in the reader shows the artifact frame area flash pure white for a moment before the page appears (owner report, 2026-10-21). The light theme is not affected. Production pages such as `https://artifact-pages.dev/guide/ja/configuration.html` declare `color-scheme: light dark` and follow `prefers-color-scheme`, but only in their external stylesheet.

## Evidence and reproduction

1. Open an HTML page in the dark theme and navigate to another HTML page whose document or stylesheet arrives slowly.
2. Observed 2026-10-21 with the unfixed reader and a delayed document plus delayed stylesheet that declares `color-scheme: light dark`, sampling the frame region while the page loads:
   - Firefox 1543 and WebKit 2359 (Playwright builds): the frame area is opaque white (255,255,255) for the whole wait (WebKit: while the new frame has no document yet; Firefox: after the document committed and before its stylesheet applied), then the page.
   - Chromium (Playwright headless 1243, headed, and Google Chrome headed) with CDP screencast of every compositor frame: no white frame; the reader surface colour is shown until the page paints. The flash is therefore not reproducible in Chromium.
3. Cause (confirmed in Firefox and WebKit, not Chromium): `ArtifactWorkspace` remounts the iframe per page with `colorScheme: theme` (dark). When the embedded document's color scheme differs from the frame element's (the initial blank document, or the new document before its stylesheet declares `color-scheme`), those engines paint an opaque light canvas over the element's own dark `background`, which the existing `.artifact-frame { background: var(--surface) }` cannot prevent.

The cause is the engines' canvas backdrop rule for mismatched color schemes, not a reader state bug. The authored document is not at fault and must not be modified (no injected styles).

## Expected outcome

In the dark theme the frame area never shows white while an HTML page opens or changes; until the new document is ready, the reader's own surface colour shows. The light theme and the authored page's appearance after load are unchanged.

## Acceptance criteria

- [x] The reader keeps the artifact frame unpainted (`opacity: 0`) until its document fires `load`, so the reader surface shows meanwhile; the frame element keeps `colorScheme: theme`, so `prefers-color-scheme` inside authored pages follows the reader theme as before. Nothing is injected into or read from the author's document for this. Verified with the fix in Firefox and WebKit (no white sample during the wait) and in Chromium.
- [x] A page that loads slowly is revealed after a 1.5 s safety timeout even without `load`; failure and retry states (a hidden frame, the `alert`) are untouched; cross-origin frames work because reveal depends only on the frame's `load` event.
- [x] The preview reader's iframe gets the same treatment.
- [x] No visible change other than removing the flash (no fade).
- [x] e2e in `web/e2e/local-serving.spec.ts`: in dark theme, navigating to an HTML artifact whose response is held leaves the frame region painting only the reader surface colour and the frame hidden until load; a held response is revealed by the timeout. Both fail without the change. (Chromium cannot show the white itself, so the tests assert the hidden state plus the pixel colour.)
- [ ] Production check in the owner's browser after release (dark theme, `artifact-pages.dev/guide/ja/configuration.html` to another page); then close this issue.
