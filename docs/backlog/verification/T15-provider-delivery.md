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
- [ ] Deploy an official bundle including `LICENSE` and `THIRD_PARTY_NOTICES.txt` with the reference admin role and request both through the CDN. Offline ISSUE-016 package, IAM, route, and publisher regressions pass; live delivery proof remains open here.
- [ ] Observe enforced artifact CSP and non-loopback preview module/resource behavior after the related fixes/design ([ISSUE-037](../issues/ISSUE-037-provider-artifact-csp.md), [TD3](../technical-design/TD3-preview-origin-delivery.md)).

## Evidence

Source review corrected the AWS app-deploy read/list scopes, limited admin content writes to the app bundle and registry/control records, limited satellite listing/writes to its site, removed satellite preview-history deletion, and routed `/preview-bridge.js` to the origin. The ISSUE-016 regression checks that the package manifest is built from every output file, constrains those paths to the supported app route and IAM scope, verifies exact admin list/read/write access for both notices and all app paths, and confirms the route passes notice URLs to the origin while preserving origin miss handling. `npm run test:aws-deployment` passes 12/12 offline checks. The focused Go publisher tests verify deployment of both notice files with their manifest bytes, `text/plain; charset=utf-8`, and revalidation cache metadata. A local package run generated 100 manifest files and passed the complete-path constraint. These are local source and packaging checks, not a live AWS deployment. `node --check infra/aws/routes.js` and `npm run test:aws-routes` verify local route-function behavior; Terraform 1.9.8 `fmt -check -recursive` and `terraform validate` pass. A no-refresh plan with sample variables also passes in an isolated copy with AWS account checks disabled; this is not a real-account plan. The Cloudflare MinIO + purge-mock profile additionally verifies unregister path translation and local origin withdrawal, but does not prove zone purge or CDN revalidation. A local nginx or route-function result cannot close provider-specific proof; all live AWS and Cloudflare delivery checks above remain open.

IMP-30 adds `npm run test:aws-deployment` for local Terraform-source contracts and Terraform 1.9.8 schema/plan checks. Those source results do not mark any live T15 check complete; neither an AWS account nor a deployed browser target was exercised. Viewer login/authorization is operator-managed at the edge and is not an Artifact Pages acceptance criterion; this item proves static delivery, storage isolation, publisher credentials, cache, and invalidation only.
