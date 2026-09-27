# IMP-21 — Browser discovery from the deployed registry

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-20](IMP-20-registry-projection.md)
- Proves: browser E2E for registered multi-site deployment

## Outcome

Use `/_indexes/sites.json` as the registered deployment's site-discovery source without regressing the Phase 1 directory-listing reference path.

## Acceptance criteria

- Registered mode loads IDs and names from the JSON registry, then per-site `meta.json`; it fetches a site's full `index.json` only when that site becomes active.
- Unregistered site data left in storage is not discoverable through the root or site chooser.
- Empty, missing, malformed, and newly changed registry states have explicit tested UI behavior; local directory-listing mode still works.
- Multi-site E2E confirms initial requests do not download every site's artifact index.

## Evidence

On 2026-09-27, `npm run build` and `npm run test:e2e` passed; all 50 browser cases passed. E2E covers registry-backed names and metadata, hides the stored but unregistered `showcase` site, loads no full indexes on the root chooser and only the active site's index after selection, and exercises empty, malformed, renamed, and missing-registry states. The Phase 1 nginx directory-listing fallback remains covered. The `SitePage` applies the registered display name at render time so registry completion does not re-fetch an unchanged active index or unmount an open site-switcher palette.
