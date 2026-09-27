# IMP-33 — Cloudflare application and content deployment reference

- Status: Open
- Phase: Provider-backed deployment
- Depends on: [T12](../technical-design/T12-cloudflare-production-mapping.md), [IMP-31](IMP-31-app-distribution.md), [IMP-32](IMP-32-cloudflare-production-adapter.md)
- Proves: external two-repository browser smoke

## Outcome

Document and exercise a Cloudflare deployment that serves the same app and site URLs, cache/access boundary and registry model.

## Acceptance criteria

- A clean admin repository can deploy the versioned app and registry; a separate satellite can publish its site using only its allowed credentials and deployed registry.
- Logical routes, missing-resource 404s, mutable cache bounds, control-object isolation and preview-retention behavior match the specification.
- Document operator setup and provider-specific limitations; do not add a request-time backend merely to emulate S3.
