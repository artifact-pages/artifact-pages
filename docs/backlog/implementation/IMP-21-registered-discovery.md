# IMP-21 — Browser discovery from the deployed registry

- Status: Done
- Phase: Provider-backed deployment
- Depends on: [IMP-20](IMP-20-registry-projection.md)
- Proves: browser E2E for registered multi-site deployment

## Outcome

Use the static `/_indexes/sites.json` catalog as the site-discovery source in both fixture and registered modes. Browser discovery does not depend on nginx directory listing or object-storage listing, as specified in [§5.1](../../specification.md#51-site-discovery).

## Acceptance criteria

- Registered mode loads IDs and names from the JSON registry, then per-site `meta.json`; it fetches a site's full `index.json` only when that site becomes active.
- Unregistered site data left in storage is not discoverable through the root or site chooser.
- Empty, missing, malformed, and newly changed registry states have explicit tested UI behavior; browser discovery does not fall back to `/_indexes/` directory listing.
- Multi-site E2E confirms initial requests do not download every site's artifact index.
- A registered site with a missing, invalid, or unreachable metadata file stays in discovery without a fabricated artifact count; healthy-site search/navigation continues.
- The registered local flow browses a site before its first publish and again after the publisher creates its metadata and index.

## Evidence

`npm run test:e2e` passed all 59 browser cases on 2026-09-28. Coverage includes registry-backed names and metadata, isolated 404/invalid/network metadata failures, the registered-but-unpublished UI with a healthy neighbor, first-publish metadata/count/navigation, current-site versus catalog errors, and lazy full-index loading. It also covers empty, malformed, renamed, and missing-registry states, and confirms that discovery never requests `/_indexes/` as a directory listing. `npm run test:registered-flow` passed on 2026-09-28; its local publisher flow serves the real registry with one healthy published site and one site with no metadata/index, runs the browser before first publish, then publishes that site and verifies the resulting discovery and navigation.
