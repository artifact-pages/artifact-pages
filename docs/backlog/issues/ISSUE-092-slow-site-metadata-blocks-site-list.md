# One slow site metadata request holds the whole home page

- Status: Open
- Priority: P2
- Area: Site discovery
- Implementer: Claude
- Source: public-launch review 2026-10-13, finding R6

## Problem

`discoverSites` waits for the metadata request of every registered site before returning, with no per-request timeout and no concurrency cap. The home page shows "Loading sites..." until discovery finishes, so a single hanging request keeps every site hidden. A failed request falls back to a per-card state, but a request that never settles never does. This was not observed in production.

## Evidence and reproduction

1. `discoverSites` (`web/src/data/indexes.ts:187`) fetches `sites.json`, then runs `Promise.all(registry.sites.map(...))` (line 199); each task awaits `loadSiteDiscoveryMetadata` with no timeout.
2. `web/src/App.tsx:99` starts discovery and line 114 renders `StatusPage` "Loading sites..." while `sites.status === 'loading'`.
3. With one metadata request that never resolves, the home page stays in loading. (Code reading; no browser repro was recorded.)

## Expected outcome

Registered sites appear as soon as the registry is read, and each card fills in its metadata when it arrives or shows the existing unavailable state.

Options (the choice is left to the implementation brief):

- Show the registry's own site entries first and fill metadata per card as each request completes.
- Keep the single result but add a per-request timeout and a bounded concurrency.

## Acceptance criteria

- [ ] The home page renders registered sites without waiting for every metadata request.
- [ ] The existing availability states (`available`, `not-published`, `needs-republish`, `metadata-unavailable`) and the specification's behavior for them are unchanged.
- [ ] A test with one never-resolving metadata request shows the other sites and a pending or unavailable state for the slow one.
