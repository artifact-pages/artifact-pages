# T25 — Web first load and search at scale

- Status: In progress
- Assignee: Claude
- Phase: Pre-launch
- Scope: first-load cost, current search, directory and sidebar at the size the launch advertises
- Implementer: Claude
- Source: public-launch review 2026-10-13, section 3 (browser start cost, search) and findings R3 and R5
- Related: [ISSUE-093](../issues/ISSUE-093-directory-and-sidebar-render-every-row.md), [ISSUE-094](../issues/ISSUE-094-site-index-cache-never-evicts.md), [ISSUE-095](../issues/ISSUE-095-home-folder-counts-load-full-indexes.md), [ISSUE-110](../issues/ISSUE-110-site-index-deadline-covers-body-download.md), [ISSUE-111](../issues/ISSUE-111-snippet-budget-omits-late-documents-at-scale.md)

## Contract to prove

The reader's first load and search stay usable up to a stated site size, and the launch documents that size.

Known numbers: the entry JS of the build at `04783fb3` is 745.83 kB minified, 227.14 kB gzip. Mermaid and the full-text decoder are already loaded lazily. The 2026-10-01 full-text benchmark (`docs/research/fulltext-local-load-benchmark.md`) used the research UI and a synthetic corpus: 50,000 pages, constrained cold input-to-paint p95 1,771.4 ms, root 326.1 KB. It does not measure the current results page, ranking or snippet packs.

## Exit criteria

- [ ] On a low-end device profile and a slow network, measure first paint, time to interactive, site switch, first search and first Mermaid render separately; pick improvements only from the dominant measured cost.
- [ ] Measure current search: few and many hits, short common terms, Japanese, long bodies, a vanished generation, a folder filter and paging. Account for up to 6 parallel shard fetches, main-thread result computation, and the snippet caps (32 MiB per site, 256 KiB per pack).
- [x] Measure the directory page and sidebar, and peak heap, at the size the launch advertises (50,000 or 100,000 pages only if claimed).
- [x] Output: a published measurement report stating the sizes measured and the results (owner 2026-10-14: results are shown as measured, not as a support claim).

## Evidence

Report: [web-scale-benchmark.md](../../research/web-scale-benchmark.md). Measured up to 50,000 pages per site (local nginx at 1,000 / 5,000 / 10,000 / 50,000; Cloudflare R2 + Cache at 10,000 / 50,000; unthrottled and constrained profiles, 3 iterations, cold and warm). The numbers are measurements, not a support limit.

- 50,000 pages, constrained, cold: opening the site transferred 45.5 MB uncompressed from local nginx (rendered home in 234 s) and 2.6 MB brotli-encoded from Cloudflare (15.4 s).
- 50,000 pages, unthrottled: rendered home 656 ms (local) and 969 ms (Cloudflare), heap after GC about 36 MB.
- The 5,000-page folder without a README rendered 5,000 DOM rows (about 99,700 elements) in 982 ms unthrottled and 3.5 s constrained; the sidebar filter "report" rendered 50,001 rows in 1.6 s unthrottled and 6.1 s constrained.
- Common-term search at 50,000 pages, unthrottled cold: 750 ms locally, 1,169 ms on Cloudflare, 6 shard fetches (1.92 MB local, 1.08 MB Cloudflare).

Extended local phase, 2026-10-17 (unreleased build at `c7d5d2b9`, local nginx without compression, 3 iterations, median; sizes 1,000 to 50,000 pages; see [the report](../../research/web-scale-benchmark.md#extended-local-phase-2026-10-17)):

- Time to interactive proxy (recorded value minus the harness's 5,000 ms quiet window, about ±100 ms resolution), first load of `/`, cold: 117 ms unthrottled and 4,978 ms constrained at 50,000 pages; the same at every size because the site list now reads only `sites.json` and `meta.json` (840 kB cold, 769 kB of it entry JS).
- First Mermaid render at 50,000 pages, unthrottled: 1,369 ms cold, 1,184 ms warm, with 3 main-thread long tasks (888 ms in total, longest 763 ms) cold; 260 ms at 1,000 pages with none. Constrained: 13.8 s cold at 1,000 pages; at 5,000, 10,000 and 50,000 pages every visit failed with "Unable to load this site" at about 24.6 s cold and 20.2 s warm, because the 20 s site-index deadline covers the body download of the uncompressed local `index.json` ([ISSUE-110](../issues/ISSUE-110-site-index-deadline-covers-body-download.md)).
- Seven search cases at 50,000 pages, unthrottled, inside an open workspace: many hits (20,254) 282 ms, few hits 74 ms, Japanese 118 ms, long body 90 ms, folder filtered 91 ms, vanished generation 90 ms; the common-term second page and the vanished-generation page after republishing (7 requests, 1.94 MB, new count 524, paging restarted, no error) are in the report. Opening the workspace first transferred the 46.74 MB site index (646 ms mounted).
- Snippet budget: 18,956 of 50,308 documents have no snippet at 50,000 pages because of the 32 MiB site budget, in path order ([ISSUE-111](../issues/ISSUE-111-snippet-budget-omits-late-documents-at-scale.md)).

Criteria left open, and why: the first two criteria stay open. The browser matrix now has first paint, time to interactive proxy, first search and first Mermaid render for the emulated profile (CPU x4, 150 ms RTT, 1.6 Mbps), and the current-search cases are measured at 50,000 pages unthrottled. Still missing: (1) a physical low-end device; (2) the constrained profile for the extended search cases, which cannot run on local uncompressed delivery because the 45.90 MB `index.json` meets the 20 s site-index deadline (ISSUE-110 was settled on 2026-10-18 as a documented constraint with no deadline change, so measure through a compressing delivery path); (3) a Cloudflare re-run of the time to interactive proxy, the first Mermaid render and the extended search cases. Leave this item In progress until these are measured or the owner accepts the emulated, unthrottled and local results as sufficient.
