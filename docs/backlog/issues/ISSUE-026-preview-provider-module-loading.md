# Load preview modules without weakening the frame boundary

- Status: Blocked
- Priority: P2
- Area: Preview reader / provider delivery
- Review: 2026-09-28, finding 13, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-14](../implementation/IMP-14-provider-serving.md), [T4](../verification/T4-serving-boundary.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)
- Blocker: TD3 must settle provider-style preview delivery without weakening accepted isolation boundaries.

## Problem

The provider-style reader falls back to srcDoc in an opaque-origin sandbox. Static ES modules request with Origin:null, but reference delivery has no compatible CORS response. Local preview.localhost tests use a different origin model and do not reveal the production-style failure.

## Evidence and reproduction

1. Exercise the non-loopback reader path with preview HTML importing a local ES module, using an independent HTTP/Chromium test setup.
2. The review observed moduleLoaded=false and a CORS failure under the configured srcDoc sandbox.
3. Adding ACAO:null only as a diagnostic made the module load. That diagnostic is not an accepted fix: it can break the existing third-party opaque-origin read boundary. Live AWS/Cloudflare responses were not tested.

Reviewed source: [src/components/PreviewDocumentPage.tsx:209](../../../src/components/PreviewDocumentPage.tsx), [src/data/previews.ts:40](../../../src/data/previews.ts). The review's supplementary local evidence is `.local/reviews/2026-09-28/delivery-evidence.md / non-loopback-equivalent Chromium reproduction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Provider-style HTML previews load ordinary bundled modules while preserving the intended app/frame and third-party-read boundaries.

## Acceptance criteria

- [ ] Settle the delivery/origin contract in TD3 before implementing a fix; do not silently adopt a new hostname or trust relaxation.
- [ ] Test a non-loopback-equivalent host with real HTTP and browser module execution, relative resources, and parent navigation.
- [ ] Retain the third-party opaque-origin read regression and verify application DOM isolation under the chosen design.
- [ ] Apply the chosen contract consistently to local profiles and supported-provider references; actual provider proof remains in T15.
