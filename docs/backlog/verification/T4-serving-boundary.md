# T4 — Serving routes, cache, and access control

- Status: In progress
- Phase: Phase 1 local analogue; provider serving remains post-MVP

## Contract to prove

Direct preview URLs work without catalog membership; a missing raw file is a real 404 rather than the SPA shell. A restricted site authorizes catalog, manifest, documents, and resources before shared-cache delivery.

## Exit criteria

- [x] Exercise direct load and reload of a fixed preview URL without catalog membership.
- [x] Verify that missing manifests are hidden in the Previews list and missing raw resources return 404.
- [x] Verify that a third-party opaque-origin sandbox cannot read preview objects while the isolated local frame can load preview resources.
- [ ] Verify browser/CDN cache behavior for mutable catalog responses and removed objects.
- [ ] Verify public and restricted sites at the serving boundary, including catalog, manifest, HTML/Markdown, and local resources.

## Evidence

On 2026-09-27, the focused Playwright boundary checks passed. An opaque-origin sandbox on a different local host cannot read an HTML preview object, and the isolated local frame loads its relative image and font resources. The updated config removes `Access-Control-Allow-Origin: null`; the app reads catalogs/manifests on its own origin while HTML and local resources are served from `preview.localhost` in a sandboxed iframe. The preview route remains separate from nginx SPA fallback in [`default.conf`](../../../docker/nginx/default.conf).

The local preview origin binds to loopback in Compose. The reader no longer grants any CORS exception to opaque origins. Its HTML frame uses the separate `preview.localhost` origin, which lets same-origin resource loading work while keeping the frame cross-origin from the application. External frame embedding is restricted by the isolated server's `frame-ancestors` policy.

Local serving is only an analogue. CDN freshness/removal, public and restricted-site authorization, and access-before-cache behavior remain unverified. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).

## Implementation links

[IMP-01 records](../implementation/IMP-01-preview-records.md), [IMP-07 local serving](../implementation/IMP-07-local-serving.md), [IMP-08 reader](../implementation/IMP-08-preview-reader.md), [IMP-10 PR return link](../implementation/IMP-10-pr-return-link.md), [IMP-14 provider serving](../implementation/IMP-14-provider-serving.md), [IMP-15 retention](../implementation/IMP-15-provider-retention.md), and [IMP-13 Action](../implementation/IMP-13-action.md) supply the surfaces to verify. Local route tests alone cannot satisfy the CDN/access-control criteria.
