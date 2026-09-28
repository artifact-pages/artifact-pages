# Revalidate fixed-name application assets on upgrade and rollback

- Status: Open
- Priority: P2
- Area: App deploy / browser and edge cache
- Review: 2026-09-28, finding 06, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-31](../implementation/IMP-31-app-distribution.md), [T4](../verification/T4-serving-boundary.md)

## Problem

Accepted fixed-name assets such as `assets/app.js` receive a one-year immutable cache policy. Updating their bytes at origin and invalidating only index.html does not make an existing browser fetch the new application. Origin-byte upgrade checks miss this failure.

## Evidence and reproduction

1. Deploy a valid bundle with fixed-name `assets/app.js`, load it in Chromium, and observe its first value.
2. Deploy a second valid bundle changing the same asset URL, then reload in the same browser.
3. The review observed the old value and only one asset request even though origin contained the second bundle.

Reviewed source: [internal/publisher/publish.go:157](../../../internal/publisher/publish.go), [docker/edge/nginx/s3.conf:42](../../../docker/edge/nginx/s3.conf), and equivalent AWS/GCS cache mappings. Supplementary local evidence is in `.local/reviews/2026-09-28/delivery-evidence.md` and `storage-evidence.log` (`TestReviewUnhashedAssetUpgrade`); it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Only content-addressed application assets are long-lived immutable; fixed-name application files revalidate as specified.

## Acceptance criteria

- [ ] Browser upgrade and rollback tests retain an existing browser cache and verify the executed asset version, not just origin bytes.
- [ ] Fixed-name assets and other mutable app files receive revalidating browser/edge policies; actual content-hashed assets retain immutable caching.
- [ ] Local AWS/Cloudflare/GCP-equivalent serving profiles and reference supported-provider mappings agree on this distinction.
- [ ] Cache invalidation and no-op deployment behavior do not hide stale fixed-name assets; live CDN proof remains in T4/T15.
