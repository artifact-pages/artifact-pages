# IMP-28 — Local admin and satellite reference flow

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-21](IMP-21-registered-discovery.md), [IMP-23](IMP-23-registry-apply.md), [IMP-26](IMP-26-site-publish-command.md), [IMP-27](IMP-27-admin-unregister.md)
- Proves: two-checkout E2E and local serving contract

## Outcome

Demonstrate the complete registered-site flow with an admin checkout, a separate site checkout and a local provider adapter before cloud deployment.

The shared local path is documented in [Local registered-site development](../../guides/local-registered-sites.md). Compose can serve a generated `.local/storage` projection through the same browser routes as fixture and provider-backed content.

## Acceptance criteria

- One documented local sequence applies registry, publishes selected source, browses it through the SPA, updates/removes stale files, then unregisters the site.
- Satellite uses the deployed registry and shared config target, not a copied `sites.yaml`; a second site remains untouched.
- Tests include site discovery, relative HTML/Markdown resources, reload/deep-link and failure/retry boundaries; generated state remains ignored under `.local/`.

## Evidence

`npm run test:registered-flow` passed on 2026-09-27. The runner used separate admin and satellite checkouts and a shared configured local backend, then verified dry-runs, two-site publish, update/stale removal, nginx/Playwright resource and reload behavior, retry cases, and site-scoped unregister with preview preservation for the neighboring site. The linked [T13](../verification/T13-registered-flow.md) records the full evidence and keeps real-provider behavior separate.
