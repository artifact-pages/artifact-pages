# Expired site-index cache entries stay in memory until the same site is read again

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web data loading
- Implementer: Claude
- Source: public-launch review 2026-10-13, finding R4

## Problem

The module-global index cache checks its 30 s TTL only when the same key is read again. A site the user has left keeps its fulfilled promise and parsed `SiteIndex` for the life of the tab, so memory grows with the number of distinct sites visited. This does not duplicate the same site.

## Evidence and reproduction

1. `indexCache` (`web/src/data/indexes.ts:57`) is a `Map`; `SITE_INDEX_CACHE_TTL_MS = 30_000` (line 54) is compared against `startedAt` only inside `loadSiteIndex` for the same key.
2. A successful entry keeps its promise; the subscriber count is not decremented on success and the abort listener is removed, so a later unmount abort does not evict it.
3. With a synthetic clock advanced 62 s, reading alpha, then beta, then gamma leaves all three keys in the map after three fetch calls (public-launch review 2026-10-13, workspace-local report).

4. Rechecked at `86841bb1` on 2026-10-15 with an instrumented copy of the module and a synthetic clock: alpha at t=1 s, beta at t=32 s, gamma at t=63 s left all three keys retained after three fetch calls; TTL remained 30,000 ms. Supplementary workspace evidence: `reviews/2026-10-15-project/reproductions.json` and `reproduce.mjs`. No production cache was modified.

## Expected outcome

Entries that are expired or no longer in use are evicted, and the cache has a size bound, without breaking the shared-request contract.

## Acceptance criteria

- [x] Expired entries are evicted without waiting for the same key to be read again.
- [x] The cache has an entry-count or size cap; entries still in use (active subscribers) are kept.
- [x] The existing abort and reuse contract for shared in-flight requests is unchanged.
- [x] A unit test with a synthetic clock covers expiry, the cap and in-use retention.

## Verification

- `web/src/data/indexes.test.mjs` (synthetic clock via `mock.timers`): expiry eviction by timer and by the next-read sweep (alpha/beta/gamma leaves only gamma), cap of `SITE_INDEX_CACHE_MAX_ENTRIES` (4) evicting the oldest entry first, entries with waiting callers kept beyond the cap, shared request aborted only when every caller aborted, abort after fulfilment keeps the entry.
- `npm run test:web-unit`: all suites pass (indexes: 25 tests).
- `npm run build` clean; full e2e (`CI=1`, 227 tests, compose project `claude-issue-094-101-102`) passed.
