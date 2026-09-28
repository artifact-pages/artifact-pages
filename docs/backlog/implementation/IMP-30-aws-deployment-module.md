# IMP-30 — AWS reference deployment module

- Status: Done

The reusable module source is in [infra/aws](../../../infra/aws/README.md). It provisions the private S3/CloudFront OAC boundary, route function, TTL policies, preview lifecycle, and separate OIDC roles. Account deployment and browser/OIDC smoke evidence remain open in [T15](../verification/T15-provider-delivery.md).
- Phase: Provider-backed deployment
- Depends on: [IMP-29](IMP-29-aws-production-adapter.md), [IMP-31](IMP-31-app-distribution.md)
- Proves: [T15](../verification/T15-provider-delivery.md)

## Outcome

Provide the documented, reusable AWS infrastructure to serve the versioned app and changing site projection.

## Acceptance criteria

- Terraform provisions private S3, CloudFront OAC, SPA fallback, separated application/content behaviors, correct cache bounds and no public control-object route.
- Separate admin and satellite GitHub OIDC roles allow only intended registry/app/site/control operations; site registration does not rewrite IAM.
- Local source-contract tests cover the route function, private-origin policy, cache mappings, IAM boundaries, preview lifecycle, role-name limits, and CLI target output.
- Preview routes use the raw-origin/no-store boundary and prefix-scoped lifecycle configuration. Viewer identity and access policy are customer-managed at the CloudFront/edge boundary, not per-site Artifact Pages configuration; lifecycle and deployed serving observations remain in [T15](../verification/T15-provider-delivery.md).

Real-account OIDC role assumption, deployed-browser and response-header behavior, provider IAM permission enforcement, and lifecycle timing evidence is tracked in [T15](../verification/T15-provider-delivery.md), which remains open until those checks run against disposable provider targets.

## Source review note

The satellite trust policies compare configured GitHub `sub` claims with `StringEquals`. A satellite can read and list its own preview records so it can inspect the current catalog and manifests, while it cannot delete retained revisions. The admin role can inspect and publish the complete app bundle, including `LICENSE`, `THIRD_PARTY_NOTICES.txt`, and the root `preview-bridge.js`; its content writes are limited to exact root files and the `assets/*` prefix, alongside the registry and registry control records. The CloudFront route function passes those app files through to the object origin. Long site IDs retain their full storage scope and ARN map key; only the AWS role's display name uses a stable hash when the readable name would exceed IAM's 64-character limit.

The local deployment source-contract suite, run with `npm run test:aws-deployment`, verifies blocked no-store control paths, pass-through for application, notice and data-plane objects, logical-route fallback, private OAC access, cache behavior mappings, preview lifecycle scope, and separated admin/satellite permissions. Its bundle-path check ties every generated manifest path class to the exact admin list/read/write scopes and rejects unscoped root files. It does not exercise a deployed CloudFront distribution.

The module's `price_class` input is applied to the distribution. The project Docker runtime `hashicorp/terraform:1.9.8` passes `fmt -check -recursive`; `init -backend=false -input=false` and `validate` pass in an isolated `.local/` copy; and a `plan -refresh=false` with a long valid site ID plans 19 additions, including a bounded-length satellite role name, with no changes or removals. The isolated plan used fake credentials and added provider credential/account-check skips only in its temporary copy; it did not contact or change an AWS account. `npm run test:aws-deployment` passes 12/12. Deployed routing, OIDC role assumption, provider IAM permission enforcement, response headers, and lifecycle timing remain unverified in T15. Operator-managed viewer-access configuration is outside the module's product policy.
