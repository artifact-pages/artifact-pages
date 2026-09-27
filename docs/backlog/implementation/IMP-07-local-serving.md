# IMP-07 — Local preview serving and 404 boundary

- Status: Open
- Phase: Post-MVP preview
- Depends on: [IMP-01](IMP-01-preview-records.md); fixture records may precede the publisher.
- Proves: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md)

## Outcome

Extend the local static-serving analogue so logical preview routes reach the SPA while raw `/_previews/*` catalog, manifest and bundle objects remain direct static resources with real missing-file status. Do not expose storage keys as primary user navigation.

## Acceptance criteria

- A direct logical preview document route loads and reloads using fixture data; absent document/manifest shows the app's neutral unavailable state.
- A missing raw `/_previews/.../files/*` request returns 404, not a 200 SPA shell (the current baseline fails this).
- Correct content types and relative-resource paths are exercised for HTML, Markdown, CSS, JavaScript, images and fonts, including encoded path segments.
- Local response/caching behavior is documented as an analogue, not claimed to prove CDN policy or restricted-site authorization.
