# T25 — Web first load and search at scale

- Status: Open
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
- [ ] Measure the directory page and sidebar, and peak heap, at the size the launch advertises (50,000 or 100,000 pages only if claimed).
- [ ] Output: a supported site-size statement for the launch.

## Evidence

(empty)
