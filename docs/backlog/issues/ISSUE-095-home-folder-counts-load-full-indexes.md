# Home folder counts load the full index of up to eight sites

- Status: Done
- Priority: P3
- Area: Home page
- Implementer: Claude
- Assignee: Claude
- Depends on: [ISSUE-094](ISSUE-094-site-index-cache-never-evicts.md) (retention of what this loads)
- Source: public-launch review 2026-10-13, finding R5

## Problem

To show per-folder counts on site cards, the home page loads the full `index.json` of the first eight sites. This transfers, parses and retains indexes of sites the user has not opened, and contradicts the older statement that only the active site's artifact index is read. It is light for the current two-site demo; the network volume was not measured. The owner already accepted the first-load wait; this issue does not reopen that decision.

## Evidence and reproduction

1. `web/src/data/use-site-folder-counts.ts` defines `MAX_COUNTED_SITES = 8` and `COUNT_CONCURRENCY = 3` (lines 7-8) and loads each index through `loadSiteIndex` after first paint; the work is bounded and cancelable.
2. `README.md:28` and `docs/roadmap.md:33` say only the active site's artifact index is loaded.

3. Source recheck at `86841bb1` on 2026-10-15 confirms the same 8-site cap, concurrency 3 and post-paint full-index reads. Per-card transferred bytes were not measured in this review. The newly confirmed freshness-label issue is tracked separately in [ISSUE-105](ISSUE-105-site-picker-updated-date-stays-stale.md); solving it must not add another full-index read just for the date.

## Expected outcome

Folder counts no longer require the full index of an unvisited site, and the documentation matches the behavior.

Options to compare: load counts when the card becomes visible; add a small summary projection with the counts to the discovery metadata; drop the count.

## Acceptance criteria

- [x] Site cards show folder counts (or the chosen replacement) without fetching the full index of unvisited sites.
- [x] The README and roadmap statements about which indexes are read are accurate.
- [x] The chosen option is recorded with its measured transfer for a site list of eight large sites.

## Resolution

The chosen option is the summary projection: the CLI writes `rootArtifactCount`, `topLevelFolderCount` and `topLevelFolders` into `meta.json` (PR #157, shared with ISSUE-105). The site picker derives the card summary from that metadata (`folderSummaryFromMetadata`) and no longer requests any `index.json`; `use-site-folder-counts.ts` and its 8-site, 3-at-a-time loader are removed. Metadata from older publishers has none of the fields, so the card shows the count only. A site with more than four top-level folders shows the folder count; when `topLevelFolders` is absent but `topLevelFolderCount` is above four, the card still says so.

The README (line 28) and `docs/roadmap.md` (line 33) say that only the active site's artifact index is loaded. That is true again after this change, so no wording was changed. `docs/specification.md` lines 466, 478 and 1104 were checked and are also accurate.

## Verification

- `npm run build` passes; `npm run test:web-unit` passes (37 tests), including `site-folder-counts.test.mjs` (folders plus root, single group, five folders, 17 folders without a list, old metadata) and `indexes.test.mjs` (valid optional fields kept, each malformed variant dropped while the metadata is accepted).
- e2e (`local-serving.spec.ts`, compose project `claude-issue-095-105-web`): on `/` no request matches `/_indexes/<site>/index.json` after the list renders plus 1 s idle, for the card test and for a 10-site list; opening a site requests only that site's index.
- Measured transfer. Fixture `meta.json` files: frontend 402 bytes, sre 704 bytes, showcase 912 bytes. A realistic `meta.json` with 16 top-level folders, pretty-printed as the CLI writes it, is 1,459 bytes. The 50,000-page site's `index.json` transfers 45.51 MB in `docs/research/web-scale-benchmark.md` (cold: index requests transferred). For eight large sites the site list now transfers eight `meta.json` files (about 1.5 kB each, about 12 kB in total) and zero indexes; before, it transferred up to eight indexes, which is 364 MB for eight sites of that size.
