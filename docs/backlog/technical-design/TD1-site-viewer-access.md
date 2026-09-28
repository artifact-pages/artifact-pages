# TD1 — Viewer access is an operator-managed edge concern

- Status: Done
- Phase: Provider-backed deployment
- Related implementation: [IMP-14](../implementation/IMP-14-provider-serving.md)
- Related verification: [T4](../verification/T4-serving-boundary.md), [T15](../verification/T15-provider-delivery.md)

## Decision

Artifact Pages has no viewer accounts, login/session model, roles, or per-site access policy. It publishes static objects. Operators choose and configure any access control at their hosting edge or surrounding network, using provider-appropriate mechanisms such as VPN/IP restrictions, Basic Authentication, CloudFront signed cookies, or Cloudflare Access.

The operator decides whether the gate applies to a hostname, selected paths, or a broader network boundary. If content must be restricted, that configuration must cover logical app routes and the raw index, artifact, and preview paths before protected bytes can be served. Once the edge allows a request, Artifact Pages returns the same static content; it does not inspect viewer identity or partition caches by principal.

The registry/catalog expresses which sites exist and which source may publish to them, not who may view them. Removing a site from navigation or from the catalog does not protect direct object URLs. The same external edge policy applies to previews; preview content is not private merely because it is pre-merge or has a difficult-to-guess URL.

The deployment may expose customer-managed controls—for example, an optional WAF ACL input or a separately configured Cloudflare Access application—but Artifact Pages does not define or manage those policies. Provider-specific setup and its verification belong to the operator's deployment environment, not to the application contract.

## Consequences

- Do not add visibility, viewer identity, or access-policy fields to `sites.yaml`, the public registry projection, or artifact metadata for this purpose.
- Do not add application login, account management, per-site authorization, or identity-aware cache partitioning.
- AWS/Cloudflare deployment examples may document how an operator attaches an external edge policy, but that policy is not an Artifact Pages guarantee.
- If app-managed viewer permissions are ever proposed, treat them as a new product/security design requiring a separate decision; they are not implied by this contract.

## Exit criteria

- [x] State that viewer identity, login, and access policy are outside the product and owned by the operator's edge/network configuration.
- [x] Clarify that registry/catalog membership and unlisted URLs are not access controls.
- [x] Remove per-site viewer authorization from the specification, preview contract, implementation criteria, and product verification scope.
- [x] Keep provider routing/cache implementation separate from live delivery/cache proof in T4/T15.

## Evidence and traceability

The accepted boundary is recorded in [Specification §18](../../specification.md#18-viewer-access-and-identity) and applied to preview behavior in §19. [IMP-14](../implementation/IMP-14-provider-serving.md) now covers provider routing/cache only; [T4](../verification/T4-serving-boundary.md) and [T15](../verification/T15-provider-delivery.md) retain live delivery and cache evidence. Optional WAF or Cloudflare Access setup remains customer-managed deployment configuration.
