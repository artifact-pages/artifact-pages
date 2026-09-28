# T15 — AWS and Cloudflare delivery boundaries

- Status: Open
- Phase: Provider-backed deployment

## Proof needed

- [ ] For each provider, directly load/reload logical routes and nested relative resources; missing resources return 404 rather than the app shell.
- [ ] Inspect actual browser/CDN response headers for mutable indexes/artifacts, hashed app assets, content types, and disposition.
- [ ] Verify projected catalog/site objects are readable through the configured public delivery endpoint, while `/_control/*` stays denied and the private origin cannot be read directly from the public internet.
- [ ] Assume the configured admin and satellite roles through GitHub OIDC; reject unconfigured subjects and verify a satellite cannot access a neighboring site, write the registry or app plane, or delete retained preview history.
- [ ] Test provider invalidation/revalidation after unregister and confirm the serving path returns the resulting origin/edge state within the documented bounds.
- [ ] With the exact reference admin/satellite IAM policies on a fresh AWS bucket, observe absent registry, lock and site reads and verify first-use bootstrap with prefix-conditioned ListBucket permissions. Distinguish confirmed absence from denied reads without widening privileges. The review did not prove whether this setup returns 403 or 404; this is an unverified contract, not a confirmed defect.
- [ ] Deploy an official bundle including LICENSE and THIRD_PARTY_NOTICES.txt with the reference admin role and request both through the CDN ([ISSUE-016](../issues/ISSUE-016-aws-web-bundle-notice-files.md)).
- [ ] Observe enforced artifact CSP and non-loopback preview module/resource behavior after the related fixes/design ([ISSUE-037](../issues/ISSUE-037-provider-artifact-csp.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)).

## Evidence

Source review corrected the AWS app-deploy read/list scopes, limited admin content writes to the app bundle and registry/control records, limited satellite listing/writes to its site, removed satellite preview-history deletion, and routed `/preview-bridge.js` to the origin. `node --check infra/aws/routes.js` and `npm run test:aws-routes` verify syntax and local route-function behavior; Terraform 1.9.8 `fmt -check -recursive` and `terraform validate` pass. A no-refresh plan with sample variables also passes in an isolated copy with AWS account checks disabled; this is not a real-account plan. The Cloudflare MinIO + purge-mock profile additionally verifies unregister path translation and local origin withdrawal, but does not prove zone purge or CDN revalidation. A local nginx or route-function result cannot close provider-specific proof; all live AWS and Cloudflare delivery checks above remain open.

IMP-30 adds `npm run test:aws-deployment` for local Terraform-source contracts and Terraform 1.9.8 schema/plan checks. Those source results do not mark any live T15 check complete; neither an AWS account nor a deployed browser target was exercised. Viewer login/authorization is operator-managed at the edge and is not an Artifact Pages acceptance criterion; this item proves static delivery, storage isolation, publisher credentials, cache, and invalidation only.
