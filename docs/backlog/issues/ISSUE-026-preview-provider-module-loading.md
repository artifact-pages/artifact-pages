# Load preview modules under the accepted HTML trust model

- Status: Open
- Priority: P2
- Area: Preview reader / provider delivery
- Review: 2026-09-28, finding 13, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-14](../implementation/IMP-14-provider-serving.md), [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)
- Decision: TD3 is settled; the owner accepted production-equivalent trusted same-origin preview HTML on 2026-09-28. Implementation and provider evidence remain unfinished.

## Problem

The provider-style reader falls back to srcDoc in an opaque-origin sandbox. Static ES modules request with Origin:null, but reference delivery has no compatible CORS response. Local preview.localhost tests use a different origin model and do not reveal the production-style failure. The current reader also imposes preview-only execution restrictions that no longer match the accepted trust model.

## Evidence and reproduction

1. Exercise the non-loopback reader path with preview HTML importing a local ES module, using an independent HTTP/Chromium test setup.
2. The review observed moduleLoaded=false and a CORS failure under the configured srcDoc sandbox.
3. Adding ACAO:null only as a diagnostic made the module load. That diagnostic is not an accepted fix: it can grant reads to unrelated opaque-origin documents. Live AWS/Cloudflare responses were not tested.

Reviewed source: [src/components/PreviewDocumentPage.tsx:209](../../../src/components/PreviewDocumentPage.tsx), [src/data/previews.ts:40](../../../src/data/previews.ts). The review's supplementary local evidence is `.local/reviews/2026-09-28/delivery-evidence.md / non-loopback-equivalent Chromium reproduction`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Preview HTML loads its actual raw document URL in a same-origin, unsandboxed iframe and executes ordinary bundled modules under the same trust/resource policy as production HTML. The iframe contains document styling, not hostile scripts. The publisher's approval of executable content is the trust boundary; Markdown remains sanitized and non-executable.

## Acceptance criteria

- [ ] Implement the settled TD3 contract without an additional required hostname/config field or opaque-origin srcDoc fallback.
- [ ] Test non-loopback-equivalent same-origin HTTP/browser module execution, transitive dependencies, relative CSS/images/fonts, and direct load/reload.
- [ ] Verify CSS containment and intentionally allowed parent-DOM/test-key browser-storage access using benign fixtures. Remove former assertions of hostile-script isolation and blanket blocked runtime fetch; retain the production-equivalent HTTPS resource policy and HTTP blocking.
- [ ] Retain the third-party opaque-origin/cross-origin script-read regression and reject blanket null/wildcard CORS grants; do not present a public preview path as private.
- [ ] Preserve changed/unchanged document routing, validated frame navigation messages, fixed revision URLs, PR view context, and real raw-resource 404s.
- [ ] Keep Markdown sanitization/strict Mermaid, registered-source validation, no-fork PR checks, and private control-object denial unchanged.
- [ ] Apply the contract consistently to local profiles and supported-provider references, and align trust/setup documentation. Actual deployed provider proof remains T15.
- [ ] Obtain an independent review, verify acceptance evidence, and commit the concern before marking it complete.
