# IMP-21 — Browser discovery from the deployed registry

- Status: Open
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
