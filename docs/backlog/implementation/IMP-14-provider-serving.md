# IMP-14 — Provider preview routing and cache

- Status: Done
- Phase: Post-MVP provider deployment; not Phase 1 implementation authority.
- Depends on: [IMP-07](IMP-07-local-serving.md), [IMP-12](IMP-12-provider-boundary.md), [IMP-18](IMP-18-cloudflare-preview-adapter.md)
- Proves: [T4](../verification/T4-serving-boundary.md)

## Outcome

Configure and locally validate AWS and Cloudflare serving boundaries so logical preview routes load the SPA, raw preview keys remain on the content origin, missing objects never fall back to the SPA, and preview responses use the required content types and cache behavior. Viewer identity and access policy are customer-managed at the edge and are outside this product slice.

## Acceptance criteria

- [x] Provider route configuration keeps logical application routes and raw `/_previews/*` objects distinct; a missing raw preview object returns a real 404.
- [x] AWS and Cloudflare source/config checks cover preview route exclusions, raw misses, and the intended cache policy.
- [x] Local browser and edge-profile tests exercise preview documents and relative resources, including content types and missing-object behavior.
- [x] Live CDN freshness and invalidation propagation remain separate verification work in T4/T15; no live-provider result is inferred from local tests.

## Evidence

- `npm run test:provider-delivery` checks AWS and Cloudflare preview route behavior, SPA exclusions, cache-policy wiring, and non-cached raw misses.
- `npm run test:e2e` passed all 55 local nginx browser tests, including logical-route reload, raw preview 404s, and catalog, manifest, Markdown, HTML, CSS, script, image, and font responses.
- `go test ./internal/publisher -run 'TestPreviewObjectMetadataUsesStableInlineContentAndCachePolicies|TestPublishRegistryRetriesRemovedSiteCleanupAfterPostWriteFailures|TestUnregisterSiteRetriesForcedCleanupWhenRegistrationIsAlreadyAbsent' -count=1` passed.
- `node scripts/run-edge-profile.mjs cloudflare` passed against local MinIO and a purge mock, verifying preview manifest availability, unregister cleanup, neighboring-site preservation, and purge paths. This does not prove real Cloudflare edge behavior.

## Product boundary

Artifact Pages has no viewer accounts, login/session model, roles, per-site permissions, or authorization-aware cache keys. Operators may protect their distribution with provider-specific edge/network controls; the product does not define or verify those policies. See [TD1](../technical-design/TD1-site-viewer-access.md) and [Specification §18](../../specification.md#18-viewer-access-and-identity).

Live AWS/Cloudflare delivery, cache freshness, and invalidation propagation remain open in [T4](../verification/T4-serving-boundary.md) and [T15](../verification/T15-provider-delivery.md).
