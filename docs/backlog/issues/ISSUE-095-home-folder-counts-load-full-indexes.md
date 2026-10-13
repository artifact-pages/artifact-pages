# Home folder counts load the full index of up to eight sites

- Status: Open
- Priority: P3
- Area: Home page
- Implementer: Claude
- Depends on: [ISSUE-094](ISSUE-094-site-index-cache-never-evicts.md) (retention of what this loads)
- Source: public-launch review 2026-10-13, finding R5

## Problem

To show per-folder counts on site cards, the home page loads the full `index.json` of the first eight sites. This transfers, parses and retains indexes of sites the user has not opened, and contradicts the older statement that only the active site's artifact index is read. It is light for the current two-site demo; the network volume was not measured. The owner already accepted the first-load wait; this issue does not reopen that decision.

## Evidence and reproduction

1. `web/src/data/use-site-folder-counts.ts` defines `MAX_COUNTED_SITES = 8` and `COUNT_CONCURRENCY = 3` (lines 7-8) and loads each index through `loadSiteIndex` after first paint; the work is bounded and cancelable.
2. `README.md:28` and `docs/roadmap.md:33` say only the active site's artifact index is loaded.

## Expected outcome

Folder counts no longer require the full index of an unvisited site, and the documentation matches the behavior.

Options to compare: load counts when the card becomes visible; add a small summary projection with the counts to the discovery metadata; drop the count.

## Acceptance criteria

- [ ] Site cards show folder counts (or the chosen replacement) without fetching the full index of unvisited sites.
- [ ] The README and roadmap statements about which indexes are read are accurate.
- [ ] The chosen option is recorded with its measured transfer for a site list of eight large sites.
