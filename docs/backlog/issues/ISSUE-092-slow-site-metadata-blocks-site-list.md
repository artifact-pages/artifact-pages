# One slow site metadata request holds the whole home page

- Status: Done
- Assignee: Claude
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

Options considered:

- Show the registry's own site entries first and fill metadata per card as each request completes.
- Keep the single result but add a per-request timeout and a bounded concurrency.

Decision: the second option. It keeps the `SiteCatalogEntry` contract, the title sort and the availability states that `App.tsx` and `SitePicker` already use, and the home page waits at most the timeout (`SITE_METADATA_TIMEOUT_MS`, 10 s) instead of indefinitely. Metadata reads run with at most `SITE_METADATA_CONCURRENCY` (6) in flight, and a read that times out ends as `metadata-unavailable`. The progressive per-card option stays a possible later improvement.

## Acceptance criteria

- [x] The home page renders registered sites within the metadata timeout (10 s) even if a metadata request never completes.
- [x] The existing availability states (`available`, `not-published`, `needs-republish`, `metadata-unavailable`) and the specification's behavior for them are unchanged.
- [x] A test with one never-resolving metadata request shows the other sites and a pending or unavailable state for the slow one.

## Verification

- `npx tsc -b web/tsconfig.json`: clean. `npm run build`: passes.
- `npm run test:web-unit`: passes, including two new tests in `web/src/data/indexes.test.mjs`: a never-completing `meta.json` (timeout 50 ms) leaves the other two sites `available` and the slow one `metadata-unavailable`; ten sites never exceed 6 concurrent metadata requests.
- e2e against the local compose stack (project `claude-091`, port 4395), `CI=1` full suite: 223 passed, 0 failed, 0 flaky.
