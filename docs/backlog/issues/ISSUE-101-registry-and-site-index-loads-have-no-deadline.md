# Registry and active-site index reads have no application deadline

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Reader / catalog and site-index loading
- Implementer: Claude
- Source: hands-on project review 2026-10-15, N1; monorepo `86841bb1`
- Related: [ISSUE-092](ISSUE-092-slow-site-metadata-blocks-site-list.md), [T24](../verification/T24-pre-launch-browser-and-keyboard-matrix.md)

## Problem

A stalled registry read can leave every site hidden behind “Loading sites…” without a bounded transition to an error or a recovery action. ISSUE-092 bounds per-site metadata discovery, but its deadline starts only after the registry response and JSON body have been read. Active-site index loading has the same missing application-level deadline in source.

## Evidence and reproduction

1. Serve the built reader with a valid registry and metadata on a loopback server. Delay `/_indexes/sites.json` for 45 seconds, including a case where no response headers arrive.
2. Open `/`. At 31 seconds the review browser still showed only “Loading sites…” with no recovery control. This was reproduced locally, not by disrupting production.
3. Repeat with headers sent promptly but the JSON body stalled; this body-wait variant is an acceptance case, not a completed review observation.
4. In `web/src/data/indexes.ts`, `discoverSites` awaits `fetchResponse` and `response.json()` before creating the metadata deadline. `fetchResponse` supplies neither a signal nor a timeout.
5. `SitePage` in `web/src/App.tsx` calls `loadSiteIndex` without a caller signal. The active-index risk is source-confirmed; the timed browser capture above covers the registry only.

Supplementary workspace evidence: `reviews/2026-10-15-project/registry-stalled.jpg` and `review-server.py`. Reproduction does not depend on those local files.

## Expected outcome

Catalog and active-index loading settle within a deliberate application deadline and expose an actionable failure state. Leaving the relevant view does not leave abandoned reads consuming work. The timeout value and mechanism are implementation decisions, not prescribed here.

## Acceptance criteria

- [x] A registry header wait and a registry JSON-body wait both settle within the configured application deadline.
- [x] A stalled active-site index read also settles into a site-scoped error, without blocking unrelated navigation.
- [x] Leaving a view cancels or detaches its read while preserving other subscribers to a shared request.
- [x] Timeout failures can use the recovery path in ISSUE-102; retry is not poisoned by the timed-out request.
- [x] Existing bounded metadata concurrency/deadline and shared-index reuse/cancellation tests remain valid.

## Verification

- `web/src/data/indexes.test.mjs`: registry header stall and body stall each reject with `timedOut` at `REGISTRY_TIMEOUT_MS` (15 s); site-index header and body stalls reject with `timedOut` at `SITE_INDEX_TIMEOUT_MS` (20 s) and the next call starts a new request; aborting `discoverSites` rejects as aborted and aborts the registry request; the shared-request cancellation tests keep passing. `App` and `SitePage` now abort their reads on cleanup.
- e2e: `a stalled registry times out with a message and Try again recovers` (`page.clock`, 15 s).
- `npm run build`, `npm run test:web-unit` and the full e2e (227 tests) pass.
