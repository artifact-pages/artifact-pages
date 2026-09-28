# TD3 — Trusted same-origin preview rendering

- Status: Done
- Phase: Provider-backed deployment
- Decision: Owner accepted trusted same-origin preview HTML on 2026-09-28.
- Related implementation: [IMP-07](../implementation/IMP-07-local-serving.md), [IMP-08](../implementation/IMP-08-preview-reader.md), [IMP-14](../implementation/IMP-14-provider-serving.md)
- Related verification: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md), [T15](../verification/T15-provider-delivery.md)

## Decision

Preview HTML has the same trust model as production HTML: it is trusted published executable content. Pre-publish is a publication approval, not a safe renderer for arbitrary untrusted changes. The operator trusts the people and CI allowed to publish; membership in the registered repository alone is not a security assessment of its content.

Serve preview HTML and its bundled resources from the application's origin and render the actual raw document URL in an ordinary, unsandboxed iframe. The iframe separates document layout and CSS; it does not isolate hostile scripts. Preview scripts may access the parent application DOM, same-origin content, and origin-scoped browser storage just as production HTML can. No separate preview hostname, DNS/TLS setup, or deployment-config origin field is required.

Markdown remains different: render it in the native reader after sanitization, with strict non-interactive Mermaid rendering and no arbitrary script execution.

## Delivery and reader contract

- Keep logical URLs at `/:site/_previews/<head SHA>/<artifact path>` and the existing manifest/raw bundle keys. This decision changes no schemas, revision identity, publication order, retention, or discovery behavior.
- Load the actual same-origin bundle URL, so document-relative resources, CSS URLs, and module imports resolve against their head-snapshot locations. Do not use an opaque-origin `srcDoc` fallback or preserve a loopback-only isolation model as the required product path.
- Apply the production HTML resource-policy principles to the revision's raw preview namespace: local snapshot resources and external HTTPS resources are allowed subject to ordinary browser TLS/CORS/mixed-content rules. Insecure external HTTP resources stay blocked. Do not retain preview-only sandbox restrictions while claiming production-equivalent execution.
- Do not introduce blanket `Access-Control-Allow-Origin: null` or wildcard CORS to make modules work. Same-origin module loading requires no such grant. Retain a regression for cross-origin/opaque-origin script reads without broadening the serving policy; it is not a promise that publicly served objects are private or cannot be embedded.
- Keep changed-document navigation in the revision and unchanged-document navigation in production. Navigation bridge handling still validates the sending frame, origin, message shape, and manifest/index destination. Those checks are routing correctness, not a hostile-preview security boundary.
- Missing raw resources return real 404s; `/_control/*` stays denied at delivery. Publication eligibility, exact repository/source-path validation, and the no-fork PR gate remain unchanged.
- Viewer access stays outside Artifact Pages, under the operator's edge/network policy covering logical and raw paths. Same-origin script access remains part of the accepted HTML trust model even behind such a gate.

## Evidence and alternatives

The 2026-09-28 review at `50c327d886c71fc5e0d086a5967b90cd9038e01e` found that local HTML used a separate `preview.localhost` origin, while the non-loopback reader used an opaque-origin `srcDoc` sandbox. A local HTTP/Chromium reproduction recorded failed ES-module execution because requests sent `Origin: null` and reference delivery supplied no matching CORS response. Adding `Access-Control-Allow-Origin: null` was diagnostic only, not an accepted fix.

A separate delivery origin could retain execution isolation but would add origin/DNS/TLS/access-gate setup. An opaque-frame resource mechanism would require additional complexity to preserve module loading without broad read grants. The owner chose production-equivalent trusted execution instead, explicitly accepting parent-DOM/storage access and removing the preview-only isolation requirement. This is a product decision, not evidence that the chosen reader or a live provider already works.

## Design completion

- [x] Record the owner's choice and its trust/setup consequences.
- [x] Preserve registration, no-fork publication, immutable revisions, provider retention, and static routing.
- [x] Define same-origin raw-document loading, resource-policy alignment, and navigation validation without AWS-specific identity.
- [x] Record the accepted behavior in the specification and preview decision register.
- [x] Remove the design blocker from ISSUE-026 and replace obsolete isolation criteria with the accepted trust model.

## Implementation and verification handoff

ISSUE-026 completed the reader, local serving profiles, supported-provider references, and regressions on 2026-09-29. Existing parent-isolation and blocked-runtime-fetch results are historical evidence for the former model, not requirements or proof of the accepted contract.

T4/T6 record local verification of non-loopback-equivalent same-origin module execution, transitive dependencies, relative images/CSS/fonts, navigation/reload, CSS containment, intentional parent-DOM/test-key localStorage access, Markdown sanitization, and no-CORS cross-origin read behavior. T15 still owns actual deployed provider CSP, routes, cache, and resource behavior; local emulator evidence does not close that proof.

Mutually untrusted HTML publishers and fork previews remain unsupported; adding an isolation model for them would require a separate product decision.
