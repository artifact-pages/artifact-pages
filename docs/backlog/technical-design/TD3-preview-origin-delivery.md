# TD3 — Preview origin and resource delivery

- Status: Open
- Phase: Provider-backed deployment
- Related issue: [ISSUE-026](../issues/ISSUE-026-preview-provider-module-loading.md)
- Related implementation: [IMP-07](../implementation/IMP-07-local-serving.md), [IMP-08](../implementation/IMP-08-preview-reader.md), [IMP-14](../implementation/IMP-14-provider-serving.md)
- Related verification: [T4](../verification/T4-serving-boundary.md), [T6](../verification/T6-resources-navigation.md), [T15](../verification/T15-provider-delivery.md)

## Question

What delivery/origin contract lets provider-hosted HTML previews load ordinary head-snapshot resources, including ES modules, while retaining the application's frame boundary and the existing third-party opaque-origin read restriction?

This is an unresolved implementation design, not approval to introduce a new public hostname, relax the trust model, or add viewer accounts. Record any resulting product or operator-setup change explicitly before implementation.

## Evidence

The 2026-09-28 review at `50c327d886c71fc5e0d086a5967b90cd9038e01e` found different local and provider-style reader paths:

- Local HTML uses a separate `preview.localhost` origin with a sandboxed frame. Dependencies load within that origin without granting access to the application DOM.
- The non-loopback reader falls back to `srcDoc` with an opaque origin. ES module requests send `Origin: null`; reference delivery has no matching CORS response. An independent HTTP/Chromium reproduction recorded failed module execution.
- Adding `Access-Control-Allow-Origin: null` made the diagnostic fixture execute, but is not an accepted solution: unrelated opaque-origin frames can send the same origin value. T4 intentionally tests that such frames cannot read preview objects.

These are local browser and source observations, not actual AWS/Cloudflare response evidence. ISSUE-026 owns the defect; this item owns the contract choice, not a duplicate fix ticket.

## Constraints to retain

- Logical user URLs remain `/:site/_previews/<head SHA>/<artifact path>`; raw storage paths are not primary navigation.
- Preview bytes and rendering dependencies come from the selected head. Changed-document navigation stays in the revision; unchanged documents open production routes.
- Support modules, images, CSS, fonts and parent navigation while keeping preview styling/execution outside the SPA DOM under the intended frame boundary.
- Do not use blanket `Origin: null` CORS as proof of safe isolation. Test the existing unrelated-opaque-origin case against the chosen approach.
- Viewer access remains operator-managed at the edge/network, including any additional origin. Artifact Pages has no viewer accounts or application authorization model ([TD1](TD1-site-viewer-access.md)).
- Keep registered-source/no-fork publication gates, provider-owned retention, immutable revision URLs, and real raw 404s.
- Production HTML remains trusted executable content in its existing unsandboxed iframe; this preview design must not silently change production behavior.

## Candidates to evaluate

| Candidate | Potential benefit | Question to resolve |
| --- | --- | --- |
| A distinct preview delivery origin, retaining the logical app URL | Uses the working local model: dependencies are same-origin within the preview frame, while the app is cross-origin. | Origin selection, embedding, bridge validation, DNS/TLS, and external access-gate setup. A new required hostname needs explicit approval. |
| An opaque frame with a more constrained resource-delivery mechanism | May avoid a separate hostname. | Demonstrate modules/fonts without granting every opaque-origin requester access or introducing a backend/authentication service; account for complexity and static hosting. |
| Fully trusted same-origin preview execution | Closer to production HTML's trust model and simpler resource loading. | Relaxes the currently tested preview boundary, requiring an explicit trust-model/product decision; registered publishing alone does not settle it. |

The distinct-origin candidate is an investigation lead because it works locally, not a settled requirement. Prefer the smallest static solution meeting accepted boundaries. Do not implement a proxy service or expand credentials based on this backlog alone.

## Exit criteria

- [ ] Compare candidates with non-loopback-equivalent HTTP/browser fixtures: modules, transitive dependencies, fonts, navigation and third-party opaque-origin reads.
- [ ] Record the chosen contract and limitations; obtain an explicit decision for any required hostname/setup or trust-model change.
- [ ] Specify origin/config resolution, routes, embedding, bridge messages and provider headers without tying core identity to AWS.
- [ ] Update the specification and preview architecture/decision register only after settlement; keep external access control outside the product.
- [ ] Unblock ISSUE-026 with concrete local/profile/source regressions. Real deployed headers and behavior remain T15 proof.
