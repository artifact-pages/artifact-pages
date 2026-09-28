# Send the specified artifact CSP from reference provider delivery

- Status: Open
- Priority: P2
- Area: HTML artifact / AWS and Cloudflare delivery
- Review: 2026-09-28, finding 24, source revision `50c327d886c71fc5e0d086a5967b90cd9038e01e`
- Related backlog: [IMP-14](../implementation/IMP-14-provider-serving.md), [T15](../verification/T15-provider-delivery.md)

## Problem

Local nginx enforces the artifact resource policy, but reference AWS artifact behaviors and Cloudflare delivery rules do not send its CSP. The same product has different resource behavior depending on hosting. This is a confirmed configuration omission, not a live provider header observation.

## Evidence and reproduction

1. Compare specification section 7 and local nginx artifact responses with the reference provider sources.
2. Inspect the AWS artifact behavior for a response-headers policy and Cloudflare for a CSP response transform.
3. Neither supplies the required artifact CSP; publisher object metadata does not supply it either.

Reviewed source: [infra/aws/main.tf:364](../../../infra/aws/main.tf), [infra/cloudflare/delivery/main.tf:110](../../../infra/cloudflare/delivery/main.tf). The review's supplementary local evidence is `.local/reviews/2026-09-28/delivery-evidence.md / specification and delivery-source comparison`; it is ignored and is not required to understand or reproduce this issue. Preserve the reproduction as a committed regression when implementing the fix.

## Expected outcome

Reference hosting implements the existing trusted-HTML resource policy without pretending it isolates same-origin publishers.

## Acceptance criteria

- [ ] Reference AWS and Cloudflare delivery define an enforced CSP matching the current artifact contract; local source/route regressions cover it.
- [ ] Browser tests verify allowed external HTTPS resources and blocked insecure HTTP resources, with site-path behavior appropriate to the hosting scheme.
- [ ] Preserve trusted executable production HTML, inline/eval allowances where specified, and unsandboxed production iframes; do not silently adopt preview isolation.
- [ ] Document the broad HTTPS allowance and its non-isolation limitation; actual deployed headers and CDN behavior remain T15 proof.
