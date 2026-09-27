# T15 — AWS and Cloudflare delivery boundaries

- Status: Open
- Phase: Provider-backed deployment

## Proof needed

- [ ] For each provider, directly load/reload logical routes and nested relative resources; missing resources return 404 rather than the app shell.
- [ ] Inspect actual browser/CDN response headers for mutable indexes/artifacts, hashed app assets, content types, and disposition.
- [ ] Prove the registry and site data can be read by their intended roles, while control objects and private origin remain unavailable to viewers.
- [ ] Test provider invalidation/revalidation after unregister and enabled access controls before shared-cache delivery.

## Evidence

Not yet recorded. A local nginx result cannot close a provider-specific proof.
