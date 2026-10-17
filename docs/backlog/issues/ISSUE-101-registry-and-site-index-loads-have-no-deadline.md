# Registry and active-site index reads have no application deadline

- Status: Open
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

- [ ] A registry header wait and a registry JSON-body wait both settle within the configured application deadline.
- [ ] A stalled active-site index read also settles into a site-scoped error, without blocking unrelated navigation.
- [ ] Leaving a view cancels or detaches its read while preserving other subscribers to a shared request.
- [ ] Timeout failures can use the recovery path in ISSUE-102; retry is not poisoned by the timed-out request.
- [ ] Existing bounded metadata concurrency/deadline and shared-index reuse/cancellation tests remain valid.
