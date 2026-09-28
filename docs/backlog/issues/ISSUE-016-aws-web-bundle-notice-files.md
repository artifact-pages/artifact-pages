# Allow and serve the official web bundle's notice files on AWS

- Status: Open
- Priority: P1
- Area: App deploy / AWS reference delivery
- Review: 2026-09-28, finding 03, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-30](../implementation/IMP-30-aws-deployment-module.md), [T15](../verification/T15-provider-delivery.md)

## Problem

Official web archives now require `LICENSE` and `THIRD_PARTY_NOTICES.txt`. App deployment checks and writes all manifest files, but the reference AWS admin policy excludes these keys. The route function rewrites their URLs to the SPA shell. An official bundle does not fit the reference deployment contract.

## Evidence and reproduction

1. Package a current official web bundle and inspect its manifest, including both mandatory notice files.
2. Compare each manifest key with the reference admin read/write/list policy and run the CloudFront route function on the notice URLs.
3. Both keys are excluded from the admin policy and both routes rewrite to `/index.html`. This is source/route-function evidence, not a live AWS deployment.

Reviewed source: [infra/aws/main.tf:78,91](../../../infra/aws/main.tf), [infra/aws/routes.js](../../../infra/aws/routes.js). The review's supplementary local evidence is `.local/reviews/2026-09-28/delivery-evidence.md / bundle-manifest, IAM and route comparison`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

An official bundle can be verified, deployed, and served using the reference admin role, without widening satellite or content-plane privileges.

## Acceptance criteria

- [ ] The generated bundle's complete manifest is checked against scoped admin permissions; required notice files are covered by deployment reads and writes.
- [ ] Notice URLs serve the actual text files rather than SPA fallback, with appropriate content type and cache behavior.
- [ ] Missing app assets/notices retain the required real-miss behavior, and arbitrary keys are not granted blanket write access.
- [ ] Add offline policy/route regressions; record actual least-privilege deployment proof separately in T15.
