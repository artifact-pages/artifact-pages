# IMP-14 — Provider preview routing, cache and access

- Status: Open
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority.
- Depends on: [IMP-07](IMP-07-local-serving.md), [IMP-12](IMP-12-provider-boundary.md)
- Proves: [T4](../verification/T4-serving-boundary.md)

## Outcome

Configure the reference provider's serving boundary so logical preview routes load the SPA, raw catalog/manifest/bundle keys never fall back to it, and each preview object inherits its site's viewer-access policy before shared-cache delivery.

## Acceptance criteria

- Missing raw `/_previews/*` objects return real 404s; logical documents load/reload, and unavailable revision pages show the reader's neutral state.
- Mutable catalog cache freshness is bounded; manifest/document/resource content types and cache policies are verified from effective browser/CDN responses.
- Public and restricted sites consistently apply the site's policy to catalog, manifest, HTML/Markdown and local resources before shared-cache hits.
- Tests cover cached removal behavior without claiming exact-time revocation; T4 retains the independent deployed-boundary verification record.
