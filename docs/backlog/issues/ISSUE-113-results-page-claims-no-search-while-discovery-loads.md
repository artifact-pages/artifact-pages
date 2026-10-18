# The full-text results page says search is unavailable while site discovery is still loading

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Search results page (`/:site/_search`)
- Source: found 2026-10-18 while measuring ISSUE-112 (1.6 Mbps, 150 ms RTT)

## Problem

Opening the results page directly and cold (for example `/<site>/_search?q=latency`) showed "Page text search is not available - This site was published without page text search." until the site's discovery metadata (`meta.json`, which carries `fullTextUrl`) had loaded; then the results appeared. On a slow link the false message stayed visible for seconds, and a measuring harness read it as final. P2 rather than P3: it is a wrong statement about the site on a direct link to the results page, not cosmetic, though it self-corrects.

## Evidence and reproduction

1. Delay `/_indexes/<site>/meta.json` (or use a slow link) and open `/<site>/_search?q=<term>` cold.
2. Observed before the fix: the "not available" alert, then the results.

Cause (confirmed in source): the full-text client is built from `fullTextUrl` in the discovery metadata, so it is `undefined` until discovery loads. `ArtifactWorkspace` passed `available={Boolean(textSearchClient)}` to the results page, which could not tell "no `fullTextUrl`" from "metadata not loaded yet". A manifest load failure is a separate path ("Search data could not be loaded", with retry) and was correct.

## Expected outcome

While discovery is loading the results page shows its loading state, not a claim about the site. "Published without page text search" appears only once discovery has loaded and carries no `fullTextUrl`. A discovery failure (catalog load, or the site's own metadata unavailable) shows a load-failure message with Try again.

## Acceptance criteria

- [x] Delayed discovery on a direct results-page load shows "Loading search…" (a `role="status"` region) and no "not available" text; the results follow. e2e `a cold results page waits for site discovery...`.
- [x] Discovery with no `fullTextUrl` still shows "Page text search is not available" (existing e2e).
- [x] Discovery failure shows "Search data could not be loaded" with Try again, which reloads discovery and recovers. e2e `a failed discovery on the results page offers a retry...`.
- [x] Unit tests for the decision (`web/src/domain/search-availability.test.mjs`). No change to results, ranking, routes or other messages.
