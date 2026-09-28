# T4 — Serving routes and cache

- Status: In progress
- Phase: Phase 1 local analogue; provider serving remains post-MVP

## Contract to prove

Direct preview URLs work without catalog membership; a missing raw file is a real 404 rather than the SPA shell. HTML follows [TD3](../technical-design/TD3-preview-origin-delivery.md): trusted same-origin execution, with iframe CSS/layout containment but no hostile-script isolation. Markdown remains sanitized/non-executable. Provider cache behavior follows the specified freshness and invalidation boundaries. Viewer authentication and authorization are operator-managed edge concerns, not application behavior.

## Exit criteria

- [x] Exercise direct load and reload of a fixed preview URL without catalog membership.
- [x] Verify that missing manifests are hidden in the Previews list and missing raw resources return 404.
- [x] Re-prove that third-party opaque-origin/cross-origin script reads receive no blanket null/wildcard CORS grant while the same-origin preview frame loads local modules and resources under TD3. This is not a privacy guarantee for public static objects.
- [x] Verify iframe CSS containment and intentionally allowed parent-DOM/test-key storage access with benign preview fixtures; verify Markdown script sanitization separately. Former parent-isolation and blanket blocked-fetch assertions are not the accepted HTML contract.
- [ ] Verify browser/CDN cache behavior for mutable catalog responses and removed objects.
- [ ] Verify fixed-name app assets in an already-cached browser during upgrade and rollback, not only origin bytes ([ISSUE-019](../issues/ISSUE-019-unhashed-app-asset-cache.md)).
- [ ] Inject invalidation-only failure for registry registration and app deployment, then retry and record request/freshness behavior. The review observed retries becoming no-ops; determine whether each mutable-path contract converges. Keep this proof separate from the resolved unregister-cleanup retry defect.
- [ ] Verify provider route and cache behavior for catalog, manifest, HTML/Markdown, local resources, and removed objects. Do not treat customer-managed viewer-access policy as a product feature or completion criterion.

## Evidence

On 2026-09-29, `npm run test:e2e` passed 59/59. The suite verifies the raw same-origin iframe URL, non-loopback-equivalent hostname, transitive modules, relative CSS/image/font resources, validated changed/unchanged navigation, direct reload, CSS containment, intentional parent DOM and test-key localStorage access, HTTPS resources, blocked external HTTP, sanitized Markdown, no-CORS opaque-origin reads, real raw-resource 404s, and a visible failure state for a missing preview document. Malformed preview HTML paths retain a strict CSP. The AWS, Cloudflare/R2, and GCS-emulator edge profile runs each passed their object-storage checks and the same 59/59 browser suite. These are local emulator results only; live provider delivery, cache behavior, and invalidation remain in T15.

The September 27 frame/origin results below are historical evidence for the former sandboxed model. They do not establish the accepted TD3 behavior or live provider support.

On 2026-09-27, the focused Playwright boundary checks passed under the former model: an opaque-origin sandbox on a different local host could not read an HTML preview object, and the isolated local frame loaded relative image and font resources from `preview.localhost`. Those checks confirmed no `Access-Control-Allow-Origin: null` grant at that time; the current raw preview route remains separate from nginx SPA fallback in [`default.conf`](../../../docker/nginx/default.conf).

The provider source/local slice is recorded in [IMP-14](../implementation/IMP-14-provider-serving.md). `npm run test:provider-delivery` checks AWS CloudFront route behavior and Cloudflare Ruleset source for raw preview paths, SPA exclusions, non-cached raw misses, and cache-policy wiring. Local nginx browser tests verify preview catalog, manifest, HTML/Markdown, CSS, script, image, and font response behavior. The Cloudflare MinIO + purge-mock profile verifies local unregister removal and neighbor isolation. None of these exercises a real CDN cache; viewer-access policy, if configured, is customer-managed and outside this product verification.

Local serving is only an analogue. CDN freshness/removal and invalidation propagation remain unverified. T4 does not test application-level public/restricted site behavior because Artifact Pages has no such policy. An operator who adds an external edge gate verifies that configuration in their own environment. See the [proof matrix](../../architecture/preview-publishing-contract.html#proof).

## Implementation links

[IMP-01 records](../implementation/IMP-01-preview-records.md), [IMP-07 local serving](../implementation/IMP-07-local-serving.md), [IMP-08 reader](../implementation/IMP-08-preview-reader.md), [IMP-10 PR return link](../implementation/IMP-10-pr-return-link.md), [IMP-14 provider serving](../implementation/IMP-14-provider-serving.md), [IMP-15 retention](../implementation/IMP-15-provider-retention.md), and [IMP-13 Action](../implementation/IMP-13-action.md) supply the surfaces to verify. Local route tests alone cannot satisfy the provider CDN route, cache, and invalidation proof.
