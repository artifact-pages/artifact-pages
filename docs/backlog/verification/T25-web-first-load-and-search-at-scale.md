# T25 — Web first load and search at scale

- Status: In progress
- Assignee: Claude
- Phase: Pre-launch
- Scope: first-load cost, current search, directory and sidebar at the size the launch advertises
- Implementer: Claude
- Source: public-launch review 2026-10-13, section 3 (browser start cost, search) and findings R3 and R5
- Related: [ISSUE-093](../issues/ISSUE-093-directory-and-sidebar-render-every-row.md), [ISSUE-094](../issues/ISSUE-094-site-index-cache-never-evicts.md), [ISSUE-095](../issues/ISSUE-095-home-folder-counts-load-full-indexes.md)

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

Criteria left open, and why: the first two criteria are only partly covered. The report does not measure the first Mermaid render, time to interactive, a vanished search generation, folder-filtered search, search paging or long page bodies, and the low-end device is emulated (CPU x4), not physical.
