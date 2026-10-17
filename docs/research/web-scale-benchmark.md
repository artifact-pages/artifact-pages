# Web reader measurements at scale

Dates: local phase 2026-10-14, Cloudflare phase 2026-10-17, extended local phase 2026-10-17. Measured up to 50,000 pages per site.

These are measurements under the stated conditions; they are not a support limit. No number below is judged as passing or failing, and the report does not state a supported site size. Backlog item: [T25](../backlog/verification/T25-web-first-load-and-search-at-scale.md).

Three phases used synthetic sites from the same generator, the same browser harness and the same profiles:

- **Local**: the web reader built from this repository (unreleased) served by nginx in Docker, with 1,000, 5,000, 10,000 and 50,000 pages per site.
- **Cloudflare**: the production web 0.3.2 served from Cloudflare R2 + Cache in the verification environment, with 10,000 and 50,000 pages per site.
- **Extended local** (2026-10-17): a later build of the web reader on the same local nginx setup, with a regenerated data set (generator version 2), adding the time to interactive proxy, the first Mermaid render, main-thread long tasks and seven search cases at 50,000 pages. See [Extended local phase](#extended-local-phase-2026-10-17).

## Test conditions

| Item | Value |
| --- | --- |
| Dates | Local 2026-10-14; Cloudflare 2026-10-17; extended local 2026-10-17 |
| Commit | Local: base `9315e5fa` plus the benchmark harness (this branch, `claude-t25-web-scale`); Cloudflare: CLI built from this branch; extended local: base `c7d5d2b9` plus the extended benchmark harness (branch `codex-t25`, working tree not clean when measured) |
| CLI and web build | Local and extended local: CLI and SPA built from the respective checkout, unreleased (extended local entry JS 768.9 kB raw). Cloudflare: CLI built from this checkout for publishing; web 0.3.2 as deployed (entry JS 748.6 kB raw) |
| Machine | Apple M4 (arm64), 10 cores, 32 GB RAM, macOS (Darwin 25.5.0); Node 22.14.0, Go 1.26.9, Docker 27.4; the extended local phase ran on the same machine and toolchain |
| Browser | Chromium 153.0.8010.12 through Playwright 1.63.0 (also in the extended local phase), headless, viewport 1440 x 900, service workers blocked |
| Delivery, local | nginx 1.29 in the `claude-web-scale` Compose project on port 4194, over loopback, no gzip or other compression configured; `index.json` and search files are stored uncompressed (also in the extended local phase) |
| Delivery, Cloudflare | Cloudflare R2 + Cache, verification environment. Responses were brotli-encoded; client location Tokyo, home network, over the public internet |
| Unthrottled profile | No CPU or network throttling |
| Constrained profile | Chromium CPU throttling x4; 150 ms round-trip latency; 1.6 Mbps download; 0.75 Mbps upload (Chrome DevTools network emulation) |
| Cold | Fresh browser context, empty HTTP cache |
| Warm | Second visit in the same context, HTTP cache filled by the cold visit |
| Iterations | 3 per cell; the tables show the median and, in parentheses, the maximum (omitted when equal) |
| Time to interactive proxy, long tasks | Defined in the [extended local phase](#extended-local-phase-2026-10-17); not measured in the first two phases |
| Timing | Times are measured from navigation (or from the triggering action) until the element is present and two animation frames have been painted |
| Bytes | "Transferred" is the encoded body size reported by Chromium (`encodedDataLength`, headers included); "raw" is the decoded body size |

### Data shape

All sites come from one generator (`scripts/benchmark-web-scale.mjs`, seed 20261014, one generator seed per size). Pages are 120 words from a shared English vocabulary plus two Japanese sentences, about 1.2 kB each. The Cloudflare sites hold the same files as the local 10,000 and 50,000 sites.

| Pages | HTML / Markdown | Folders (with README / without) | Large flat folder without README | Folder with README | Japanese share of characters | Average page size | Source size |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 674 / 326 | 10 (5 / 5) | 695 pages | 100 pages | 4.5% | 1,211 B | 1.21 MB |
| 5,000 | 3,561 / 1,439 | 42 (18 / 24) | 3,495 pages | 500 pages | 4.5% | 1,218 B | 6.09 MB |
| 10,000 | 6,994 / 3,006 | 112 (41 / 71) | 5,000 pages | 500 pages | 4.5% | 1,216 B | 12.16 MB |
| 50,000 | 34,870 / 15,130 | 912 (308 / 604) | 5,000 pages | 500 pages | 4.5% | 1,215 B | 60.78 MB |

Layout: 5 pages at the root, a `handbook/` folder with a README, a `big-flat/` folder without a README, and the rest in `area-NN/section-NNN/` folders (maximum depth 2, 50 pages per leaf, some with a README). The large flat folder holds at most 5,000 pages, so the folder measurements at 10,000 and 50,000 pages are for the same 5,000-page folder; the extra pages sit in the nested areas. Directory and sidebar costs therefore scale with the largest folder, while site-wide costs (index, filter, search) scale with the whole site.

Extended local phase (generator version 2, same seed): the generator now puts one `flowchart` Mermaid block in `overview-0.md` at every size; at 50,000 pages it also adds a long-body page (`big-flat/page-000000.md`, 281,101 B, above the 262,144 B per-document snippet cap) and 525 pages under `000-generation/` that carry the search probe terms (they take the place of nested pages, so the layout counts are unchanged). The shape therefore differs slightly from the table above:

| Pages | HTML / Markdown | Folders (with README / without) | Average page size | Source size | `index.json` raw | `index.json` gzip level 9 (estimate) | Search files | Local `site sync` |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 673 / 327 | 10 (5 / 5) | 1,211 B | 1.21 MB | 0.78 MB | 39.9 kB | 175 files, 0.46 MB | 12.9 s |
| 5,000 | 3,561 / 1,439 | 42 (18 / 24) | 1,218 B | 6.09 MB | 4.39 MB | 265.6 kB | 350 files, 2.07 MB | 62.0 s |
| 10,000 | 6,994 / 3,006 | 112 (41 / 71) | 1,216 B | 12.16 MB | 8.92 MB | 529.5 kB | 567 files, 4.07 MB | 146.4 s |
| 50,000 | 34,513 / 15,487 | 907 (308 / 599) | 1,220 B | 61.02 MB | 45.90 MB | 2.63 MB | 1,478 files, 13.85 MB | 656.1 s |

Published size, from the CLI, for the first local phase and Cloudflare:

| Pages | `index.json` raw | `index.json` gzip level 9 (estimate) | Search files | Local `site sync` | Cloudflare `site sync` |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.78 MB | 39.9 kB | 175 files, 0.46 MB | 13.4 s | not measured |
| 5,000 | 4.39 MB | 265.6 kB | 350 files, 2.07 MB | 64.5 s | not measured |
| 10,000 | 8.92 MB | 529.5 kB | 567 files, 4.07 MB | 123.8 s | 185.9 s |
| 50,000 | 45.51 MB | 2.62 MB | 1,477 files, 13.85 MB | 608.6 s | 883.6 s |

The Cloudflare `index.json` files are 8.88 MB and 45.31 MB raw. Generating the 50,000-page site took 3.7 s and its local publish 608.6 s (Cloudflare: 883.6 s). The 50,000-page size was kept because the run fit the session's time.

## How to reproduce

Build the CLI and web, then run the harness. Local (Docker is required; the harness starts and stops the `claude-web-scale` Compose project):

```sh
npm ci
npm run benchmark:web-scale -- --counts 1000,5000,10000,50000 --iterations 3 --profiles unthrottled
npm run benchmark:web-scale -- --counts 1000,5000,10000,50000 --iterations 3 --profiles constrained
```

The harness generates the sites under `.local/web-scale/` (untracked), publishes them with `registry sync` and `site sync` to a local storage root, and writes `results-<timestamp>.json` plus a `.samples.jsonl` of every iteration. Use `--only first-load,session,search,sequence,mermaid,search-cases` to run groups separately, `--regenerate` to rebuild the data, and `--keep` to retain the raw `results-<timestamp>.json` and `.samples.jsonl` (without it the harness deletes them and the generated data after a completed run). The extended local phase used:

```sh
env NODE_OPTIONS= npm run benchmark:web-scale -- --counts 1000,5000,10000,50000 --iterations 3 --profiles unthrottled --only first-load,mermaid,search-cases --keep
env NODE_OPTIONS= npm run benchmark:web-scale -- --counts 1000,5000,10000,50000 --iterations 3 --profiles constrained --only first-load,mermaid --keep
```

`search-cases` runs only against local nginx, needs `50000` in `--counts` and includes a 61 s wait per iteration for the vanished-generation case. A completed run writes the sanitized `docs/research/web-scale-benchmark-results.json`, replacing the previous one; the committed file combines the unthrottled profile of the first run with the constrained profile of the second (the first run had been started with both profiles and stopped at 5,000 pages, constrained, Mermaid). It was produced by calling the harness's own sanitizer on the two raw results. `search-cases` was not run under the constrained profile: the 50,000-page `index.json` is 45.90 MB uncompressed locally and would meet the same 20 s site-index deadline as the Mermaid visits.

Cloudflare (an already deployed environment with two registered sites, `bench-10k` and `bench-50k`, whose `sourcePath` is `sites/<site>/content`):

```sh
# 1. Put the generated content at the registered source paths of a satellite checkout whose
#    origin matches the registered repository (here: sites/bench-10k/content, sites/bench-50k/content).
# 2. Load the deployment credentials into the environment (names depend on your config), then:
artifact-pages site sync --site bench-10k --config <PATH-TO-PRIVATE-CONFIG> --dry-run
artifact-pages site sync --site bench-10k --config <PATH-TO-PRIVATE-CONFIG>
artifact-pages site sync --site bench-50k --config <PATH-TO-PRIVATE-CONFIG>
# 3. Measure.
npm run benchmark:web-scale -- --remote https://<DEPLOYMENT-ORIGIN> --counts 10000,50000 --iterations 3 --profiles unthrottled
npm run benchmark:web-scale -- --remote https://<DEPLOYMENT-ORIGIN> --counts 10000,50000 --iterations 3 --profiles constrained
```

With `--remote`, site IDs are `bench-<count/1000>k` and nothing is generated or served locally.

## Results

Column headers: "Local N" is the unreleased build on local nginx at N pages; "Cloudflare N" is production web 0.3.2 on Cloudflare R2 + Cache. Cold and warm are defined above. "Hits" are pages containing the term. Search times run from navigation to `/<site>/_search?q=...` until the first results (or the empty state) are painted, so they include opening the site workspace. Search tables use the production full-text results page. Terms: common English `latency`, Japanese `再試行`, rare `quokkaflux` (7 pages per site), no-hit `zzqxnohit`.

"Bytes of completed responses when the list became visible" sums only responses that had finished by then; transfers still in flight at that moment are not counted.

Search method: the harness waits for a result row or the no-match state. A search error message is not accepted as a result and would invalidate the run. All 288 recorded search visits (4 terms x cold and warm x 3 iterations x 12 combinations of size, profile and phase) were checked after the fact: none showed an error message, and each showed result rows or the no-match state with a hit count, so no search measurement was re-run.

Memory is the JS heap reported by Chromium (`Runtime.getHeapUsage`). "After GC" is after two forced collections; "peak" is the highest value sampled every 100 ms during the session.

### Unthrottled profile


#### First load of /

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold: first contentful paint | 72 ms (max 108 ms) | 88 ms (max 108 ms) | 92 ms (max 100 ms) | 80 ms (max 108 ms) | 332 ms (max 1,144 ms) | 468 ms (max 492 ms) |
| cold: site list visible | 69 ms (max 94 ms) | 80 ms (max 100 ms) | 83 ms (max 94 ms) | 72 ms (max 98 ms) | 322 ms (max 1,126 ms) | 457 ms (max 473 ms) |
| cold: bytes of completed responses when the list became visible | 1.60 MB | 5.20 MB | 815.8 kB (max 9.74 MB) | 815.8 kB | 285.4 kB (max 292.3 kB) | 286.1 kB (max 292.8 kB) |
| cold: transferred, total after settling | 1.60 MB | 5.20 MB | 9.74 MB | 46.32 MB | 3.10 MB (max 3.15 MB) | 3.08 MB (max 3.10 MB) |
| cold: entry JS transferred | 748.9 kB | 748.9 kB | 748.9 kB | 748.9 kB | 234.0 kB (max 234.6 kB) | 234.6 kB (max 234.7 kB) |
| cold: entry JS raw | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB |
| cold: requests | 7 | 7 | 7 | 7 | 15 | 15 |
| cold: index requests transferred | 782.2 kB | 4.39 MB | 8.92 MB | 45.51 MB | 2.85 MB (max 2.90 MB) | 2.83 MB (max 2.85 MB) |
| warm: first contentful paint | 76 ms (max 84 ms) | 80 ms (max 84 ms) | 72 ms (max 80 ms) | 68 ms (max 80 ms) | 192 ms (max 256 ms) | 240 ms (max 248 ms) |
| warm: site list visible | 75 ms (max 84 ms) | 83 ms (max 87 ms) | 71 ms (max 78 ms) | 65 ms (max 76 ms) | 232 ms (max 264 ms) | 258 ms (max 318 ms) |
| warm: bytes of completed responses when the list became visible | 782.6 kB | 4.39 MB | 1.7 kB | 1.7 kB | 35.6 kB (max 43.0 kB) | 42.7 kB (max 43.0 kB) |
| warm: transferred, total after settling | 782.6 kB | 4.39 MB | 8.92 MB | 45.51 MB | 43.0 kB (max 43.0 kB) | 43.0 kB (max 43.1 kB) |
| warm: entry JS transferred | 0 B | 0 B | 0 B | 0 B | 0 B | 0 B |
| warm: entry JS raw | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB |
| warm: requests | 7 | 7 | 7 | 7 | 15 | 15 |
| warm: index requests transferred | 782.2 kB | 4.39 MB | 8.92 MB | 45.51 MB | 42.4 kB | 42.4 kB (max 42.4 kB) |


#### Site open

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold: time to rendered home | 92 ms (max 111 ms) | 142 ms (max 156 ms) | 209 ms (max 233 ms) | 656 ms (max 697 ms) | 404 ms (max 496 ms) | 969 ms (max 1,008 ms) |
| cold: first contentful paint | 120 ms (max 132 ms) | 156 ms (max 172 ms) | 224 ms (max 252 ms) | 668 ms (max 712 ms) | 416 ms (max 512 ms) | 984 ms (max 1,024 ms) |
| warm: time to rendered home | 79 ms (max 89 ms) | 223 ms (max 230 ms) | 348 ms (max 352 ms) | 865 ms (max 901 ms) | 362 ms (max 404 ms) | 784 ms (max 834 ms) |
| cold: index.json transferred | 781.0 kB | 4.39 MB | 8.92 MB | 45.51 MB | 470.6 kB (max 471.5 kB) | 2.34 MB (max 2.35 MB) |
| cold: index.json raw | 780.7 kB | 4.39 MB | 8.92 MB | 45.51 MB | 8.88 MB | 45.31 MB |
| warm: index.json transferred | 781.0 kB | 4.39 MB | 8.92 MB | 45.51 MB | 341 B (max 361 B) | 339 B (max 342 B) |
| cold: meta.json transferred | 635 B | 635 B | 641 B | 641 B | 538 B (max 551 B) | 536 B (max 602 B) |
| cold: meta.json raw | 365 B | 365 B | 371 B | 371 B | 344 B | 344 B |
| cold: total transferred | 1.60 MB | 5.20 MB | 9.74 MB | 46.32 MB | 769.7 kB (max 770.1 kB) | 2.64 MB (max 2.65 MB) |
| cold: heap after GC | 4.00 MB (max 4.01 MB) | 6.72 MB (max 6.72 MB) | 9.98 MB (max 9.98 MB) | 35.96 MB (max 35.96 MB) | 9.99 MB (max 9.99 MB) | 35.89 MB (max 35.89 MB) |
| warm: heap after GC | 3.90 MB (max 3.90 MB) | 6.74 MB (max 6.74 MB) | 9.93 MB (max 9.93 MB) | 35.51 MB (max 35.51 MB) | 9.99 MB (max 9.99 MB) | 35.52 MB (max 35.52 MB) |
| cold: DOM elements | 334 | 612 | 606 | 612 | 606 | 612 |
| cold: root rows in the directory page | 11 | 27 | 27 | 27 | 27 | 27 |


#### Directory pages

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| folder without README: pages in folder | 695 | 3,495 | 5,000 | 5,000 | 5,000 | 5,000 |
| folder without README: render time | 131 ms (max 134 ms) | 535 ms (max 539 ms) | 842 ms (max 886 ms) | 982 ms (max 985 ms) | 871 ms (max 931 ms) | 940 ms (max 1,223 ms) |
| folder without README: DOM rows | 695 | 3,495 | 5,000 | 5,000 | 5,000 | 5,000 |
| folder without README: DOM elements | 14,028 | 69,369 | 99,386 | 99,687 | 99,386 | 99,687 |
| folder with README: pages in folder | 100 | 500 | 500 | 500 | 500 | 500 |
| folder with README: render time | 84 ms (max 85 ms) | 200 ms (max 201 ms) | 267 ms (max 268 ms) | 284 ms (max 298 ms) | 265 ms (max 282 ms) | 341 ms (max 455 ms) |
| folder with README: DOM rows before Show all | 10 | 10 | 10 | 10 | 10 | 10 |
| folder with README: Show all time | 48 ms (max 48 ms) | 51 ms (max 52 ms) | 59 ms (max 60 ms) | 46 ms (max 46 ms) | 62 ms (max 63 ms) | 58 ms (max 59 ms) |
| folder with README: DOM rows after Show all | 100 | 500 | 500 | 500 | 500 | 500 |
| folder with README: DOM elements after Show all | 8,429 | 41,464 | 55,512 | 55,577 | 55,512 | 55,577 |


#### Sidebar

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| expand large folder: time | 64 ms (max 71 ms) | 211 ms (max 219 ms) | 298 ms (max 306 ms) | 303 ms (max 309 ms) | 305 ms (max 313 ms) | 309 ms (max 336 ms) |
| expand large folder: sidebar rows after | 700 | 3,500 | 5,005 | 5,005 | 5,005 | 5,005 |
| filter "report": time to first results | 37 ms (max 37 ms) | 153 ms (max 161 ms) | 284 ms (max 289 ms) | 1,622 ms (max 1,646 ms) | 313 ms (max 315 ms) | 1,605 ms (max 1,752 ms) |
| filter "report": result rows | 1,001 | 5,001 | 10,001 | 50,001 | 10,001 | 50,001 |
| filter "report": DOM elements | 5,641 | 27,127 | 54,179 | 271,908 | 54,179 | 271,908 |


#### Full-text search

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| common English: query | latency | latency | latency | latency | latency | latency |
| common English: cold, first results | 98 ms (max 105 ms) | 190 ms (max 201 ms) | 280 ms (max 280 ms) | 750 ms (max 834 ms) | 423 ms (max 425 ms) | 1,169 ms (max 1,666 ms) |
| common English: warm, first results | 91 ms (max 97 ms) | 179 ms (max 203 ms) | 273 ms (max 273 ms) | 778 ms (max 858 ms) | 292 ms (max 351 ms) | 631 ms (max 678 ms) |
| common English: hits | 404 | 2,002 | 4,055 | 20,254 | 4,055 | 20,254 |
| common English: cold, shard fetches | 14 | 7 | 7 | 6 | 7 | 6 |
| common English: cold, transferred | 149.1 kB | 235.2 kB | 419.4 kB | 1.92 MB | 323.2 kB (max 323.4 kB) | 1.08 MB (max 1.09 MB) |
| common English: warm, shard fetches | 14 | 7 | 7 | 6 | 7 | 6 |
| common English: warm, transferred | 149.1 kB | 235.2 kB | 419.4 kB | 1.92 MB | 341 B | 417 B (max 438 B) |
| Japanese: query | 再試行 | 再試行 | 再試行 | 再試行 | 再試行 | 再試行 |
| Japanese: cold, first results | 92 ms (max 93 ms) | 176 ms (max 208 ms) | 271 ms (max 293 ms) | 792 ms (max 806 ms) | 388 ms (max 448 ms) | 1,362 ms (max 1,577 ms) |
| Japanese: warm, first results | 99 ms (max 105 ms) | 172 ms (max 185 ms) | 281 ms (max 301 ms) | 863 ms (max 884 ms) | 261 ms (max 368 ms) | 606 ms (max 624 ms) |
| Japanese: hits | 167 | 779 | 1,576 | 7,975 | 1,576 | 7,975 |
| Japanese: cold, shard fetches | 30 | 32 | 30 | 28 | 30 | 28 |
| Japanese: cold, transferred | 140.4 kB | 327.0 kB | 509.2 kB | 2.20 MB | 414.1 kB (max 414.1 kB) | 1.36 MB (max 1.36 MB) |
| Japanese: warm, shard fetches | 30 | 32 | 30 | 28 | 30 | 28 |
| Japanese: warm, transferred | 140.4 kB | 327.0 kB | 509.2 kB | 2.20 MB | 346 B (max 415 B) | 348 B (max 364 B) |
| rare: query | quokkaflux | quokkaflux | quokkaflux | quokkaflux | quokkaflux | quokkaflux |
| rare: cold, first results | 90 ms (max 120 ms) | 137 ms (max 185 ms) | 284 ms (max 285 ms) | 775 ms (max 815 ms) | 520 ms (max 528 ms) | 905 ms (max 1,353 ms) |
| rare: warm, first results | 99 ms (max 119 ms) | 190 ms (max 192 ms) | 259 ms (max 264 ms) | 861 ms (max 891 ms) | 305 ms (max 363 ms) | 840 ms (max 898 ms) |
| rare: hits | 7 | 7 | 7 | 7 | 7 | 7 |
| rare: cold, shard fetches | 11 | 11 | 11 | 8 | 11 | 8 |
| rare: cold, transferred | 119.0 kB | 271.4 kB | 447.1 kB | 1.93 MB | 351.2 kB (max 351.2 kB) | 1.10 MB (max 1.10 MB) |
| rare: warm, shard fetches | 11 | 11 | 11 | 8 | 11 | 8 |
| rare: warm, transferred | 119.0 kB | 271.4 kB | 447.1 kB | 1.93 MB | 358 B (max 409 B) | 334 B (max 339 B) |
| no hit: query | zzqxnohit | zzqxnohit | zzqxnohit | zzqxnohit | zzqxnohit | zzqxnohit |
| no hit: cold, first results | 84 ms (max 94 ms) | 170 ms (max 185 ms) | 256 ms (max 272 ms) | 767 ms (max 792 ms) | 603 ms (max 719 ms) | 922 ms (max 935 ms) |
| no hit: warm, first results | 96 ms (max 104 ms) | 167 ms (max 174 ms) | 238 ms (max 254 ms) | 797 ms (max 804 ms) | 263 ms (max 291 ms) | 617 ms (max 641 ms) |
| no hit: hits | 0 | 0 | 0 | 0 | 0 | 0 |
| no hit: cold, shard fetches | 2 | 2 | 2 | 2 | 2 | 2 |
| no hit: cold, transferred | 49.4 kB | 108.3 kB | 181.5 kB | 1.22 MB | 84.8 kB (max 84.8 kB) | 383.2 kB (max 383.2 kB) |
| no hit: warm, shard fetches | 2 | 2 | 2 | 2 | 2 | 2 |
| no hit: warm, transferred | 49.4 kB | 108.3 kB | 181.5 kB | 1.22 MB | 347 B (max 362 B) | 342 B |


#### Heap

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| peak heap during the site session | 21.94 MB (max 22.17 MB) | 85.73 MB (max 86.15 MB) | 116.85 MB (max 117.49 MB) | 254.08 MB (max 261.30 MB) | 118.44 MB (max 131.30 MB) | 257.62 MB (max 264.42 MB) |
| heap after GC at end of session | 10.32 MB (max 10.32 MB) | 34.87 MB (max 34.87 MB) | 48.82 MB (max 48.84 MB) | 73.79 MB (max 73.80 MB) | 48.88 MB (max 48.90 MB) | 73.26 MB (max 73.48 MB) |
| peak heap, cold search (common English) | 7.20 MB (max 7.23 MB) | 13.86 MB (max 15.16 MB) | 20.19 MB (max 20.22 MB) | 76.40 MB (max 77.32 MB) | 20.24 MB (max 25.07 MB) | 76.80 MB (max 77.27 MB) |
| heap after GC, cold search (common English) | 5.71 MB (max 5.71 MB) | 8.47 MB (max 8.47 MB) | 13.23 MB (max 13.26 MB) | 47.21 MB (max 47.21 MB) | 13.27 MB (max 13.27 MB) | 47.13 MB (max 47.13 MB) |


#### Visiting every local site in sequence: scale-1000, scale-5000, scale-10000, scale-50000

| Step | open time | heap after GC |
| --- | ---: | ---: |
| / | - | 44.04 MB (max 44.08 MB) |
| scale-1000 | 50 ms | 44.71 MB (max 44.75 MB) |
| / (after scale-1000) | 28 ms | 44.56 MB (max 44.60 MB) |
| scale-5000 | 49 ms | 45.14 MB (max 45.19 MB) |
| / (after scale-5000) | 27 ms | 44.64 MB (max 44.68 MB) |
| scale-10000 | 80 ms | 45.38 MB (max 45.42 MB) |
| / (after scale-10000) | 33 ms | 44.69 MB (max 44.73 MB) |
| scale-50000 | 330 ms | 46.81 MB (max 46.85 MB) |
| / (after scale-50000) | 29 ms | 44.76 MB (max 44.80 MB) |
| / (after 35 s idle) | - | 44.76 MB (max 44.80 MB) |
| peak heap over the sequence | | 64.15 MB (max 64.20 MB) |

First load of `/` in the same setup: cold 104 ms list visible, 60.42 MB transferred; warm 68 ms, 59.60 MB.


#### Visiting both Cloudflare sites in sequence: bench-10k, bench-50k

| Step | open time | heap after GC |
| --- | ---: | ---: |
| / | - | 39.93 MB (max 40.01 MB) |
| bench-10k | 88 ms | 41.13 MB (max 41.22 MB) |
| / (after bench-10k) | 28 ms | 40.50 MB (max 40.59 MB) |
| bench-50k | 329 ms | 42.61 MB (max 42.70 MB) |
| / (after bench-50k) | 32 ms | 40.60 MB (max 40.69 MB) |
| / (after 35 s idle) | - | 40.60 MB (max 40.69 MB) |
| peak heap over the sequence | | 60.39 MB (max 60.46 MB) |

First load of `/` in the same setup: cold 486 ms list visible, 3.09 MB transferred; warm 236 ms, 43.0 kB.


### Constrained profile (CPU x4, 150 ms RTT, 1.6 Mbps down, 0.75 Mbps up)


#### First load of /

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold: first contentful paint | 4,804 ms (max 4,824 ms) | 4,828 ms (max 4,832 ms) | 4,812 ms (max 4,820 ms) | 4,812 ms | 2,032 ms (max 2,200 ms) | 2,040 ms (max 2,148 ms) |
| cold: site list visible | 4,848 ms (max 4,859 ms) | 4,881 ms (max 4,885 ms) | 4,856 ms (max 4,858 ms) | 4,854 ms (max 4,857 ms) | 2,241 ms (max 2,417 ms) | 2,258 ms (max 2,365 ms) |
| cold: bytes of completed responses when the list became visible | 815.8 kB | 815.8 kB | 815.8 kB | 815.8 kB | 285.1 kB (max 286.0 kB) | 285.8 kB (max 292.7 kB) |
| cold: transferred, total after settling | 1.60 MB | 5.20 MB | 9.74 MB | 46.32 MB | 3.07 MB (max 3.07 MB) | 3.07 MB (max 3.07 MB) |
| cold: entry JS transferred | 748.9 kB | 748.9 kB | 748.9 kB | 748.9 kB | 233.7 kB (max 234.6 kB) | 234.4 kB (max 234.6 kB) |
| cold: entry JS raw | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB |
| cold: requests | 7 | 7 | 7 | 7 | 15 | 15 |
| cold: index requests transferred | 782.2 kB | 4.39 MB | 8.92 MB | 45.51 MB | 2.82 MB (max 2.82 MB) | 2.82 MB (max 2.82 MB) |
| warm: first contentful paint | 600 ms (max 604 ms) | 636 ms (max 648 ms) | 620 ms (max 640 ms) | 628 ms (max 632 ms) | 632 ms | 612 ms |
| warm: site list visible | 648 ms (max 649 ms) | 683 ms (max 712 ms) | 669 ms (max 677 ms) | 672 ms (max 694 ms) | 844 ms (max 862 ms) | 825 ms (max 833 ms) |
| warm: bytes of completed responses when the list became visible | 1.7 kB | 1.7 kB | 1.7 kB | 1.7 kB | 28.8 kB (max 28.8 kB) | 28.8 kB (max 28.8 kB) |
| warm: transferred, total after settling | 782.6 kB | 4.39 MB | 8.92 MB | 45.51 MB | 43.0 kB (max 43.1 kB) | 43.0 kB (max 43.0 kB) |
| warm: entry JS transferred | 0 B | 0 B | 0 B | 0 B | 0 B | 0 B |
| warm: entry JS raw | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB | 748.6 kB |
| warm: requests | 7 | 7 | 7 | 7 | 15 | 15 |
| warm: index requests transferred | 782.2 kB | 4.39 MB | 8.92 MB | 45.51 MB | 42.4 kB (max 42.4 kB) | 42.4 kB (max 42.4 kB) |


#### Site open

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cold: time to rendered home | 8,695 ms (max 8,707 ms) | 26.9 s (max 26.9 s) | 49.8 s (max 49.8 s) | 234.1 s (max 234.2 s) | 4,926 ms (max 4,974 ms) | 15.4 s (max 15.5 s) |
| cold: first contentful paint | 4,816 ms | 4,820 ms (max 4,828 ms) | 4,824 ms (max 4,828 ms) | 4,828 ms (max 4,832 ms) | 2,044 ms (max 2,056 ms) | 2,028 ms (max 2,044 ms) |
| warm: time to rendered home | 4,527 ms (max 4,562 ms) | 22.8 s (max 23.1 s) | 45.6 s (max 46.1 s) | 230.4 s (max 230.5 s) | 1,457 ms (max 1,508 ms) | 2,680 ms (max 3,195 ms) |
| cold: index.json transferred | 781.0 kB | 4.39 MB | 8.92 MB | 45.51 MB | 470.0 kB (max 470.6 kB) | 2.31 MB (max 2.33 MB) |
| cold: index.json raw | 780.7 kB | 4.39 MB | 8.92 MB | 45.51 MB | 8.88 MB | 45.31 MB |
| warm: index.json transferred | 781.0 kB | 4.39 MB | 8.92 MB | 45.51 MB | 341 B (max 360 B) | 337 B (max 352 B) |
| cold: meta.json transferred | 635 B | 635 B | 641 B | 641 B | 597 B (max 615 B) | 551 B (max 607 B) |
| cold: meta.json raw | 365 B | 365 B | 371 B | 371 B | 344 B | 344 B |
| cold: total transferred | 1.60 MB | 5.20 MB | 9.74 MB | 46.32 MB | 769.1 kB (max 770.0 kB) | 2.61 MB (max 2.63 MB) |
| cold: heap after GC | 3.94 MB (max 3.94 MB) | 6.69 MB (max 6.74 MB) | 9.98 MB (max 9.99 MB) | 35.94 MB (max 35.94 MB) | 10.00 MB (max 10.00 MB) | 35.89 MB (max 35.89 MB) |
| warm: heap after GC | 3.94 MB (max 3.94 MB) | 6.79 MB (max 6.79 MB) | 10.00 MB (max 10.00 MB) | 35.91 MB (max 35.92 MB) | 9.99 MB (max 9.99 MB) | 35.51 MB (max 35.52 MB) |
| cold: DOM elements | 334 | 612 | 606 | 612 | 606 | 612 |
| cold: root rows in the directory page | 11 | 27 | 27 | 27 | 27 | 27 |


#### Directory pages

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| folder without README: pages in folder | 695 | 3,495 | 5,000 | 5,000 | 5,000 | 5,000 |
| folder without README: render time | 470 ms (max 490 ms) | 2,348 ms (max 2,360 ms) | 3,263 ms (max 3,356 ms) | 3,531 ms (max 3,687 ms) | 3,344 ms (max 3,556 ms) | 3,513 ms (max 3,660 ms) |
| folder without README: DOM rows | 695 | 3,495 | 5,000 | 5,000 | 5,000 | 5,000 |
| folder without README: DOM elements | 14,028 | 69,369 | 99,386 | 99,687 | 99,386 | 99,687 |
| folder with README: pages in folder | 100 | 500 | 500 | 500 | 500 | 500 |
| folder with README: render time | 276 ms (max 281 ms) | 621 ms (max 683 ms) | 1,002 ms (max 1,011 ms) | 1,239 ms (max 1,303 ms) | 930 ms (max 940 ms) | 1,034 ms (max 1,043 ms) |
| folder with README: DOM rows before Show all | 10 | 10 | 10 | 10 | 10 | 10 |
| folder with README: Show all time | 45 ms (max 47 ms) | 161 ms (max 178 ms) | 212 ms (max 222 ms) | 185 ms (max 195 ms) | 181 ms (max 208 ms) | 168 ms (max 178 ms) |
| folder with README: DOM rows after Show all | 100 | 500 | 500 | 500 | 500 | 500 |
| folder with README: DOM elements after Show all | 8,429 | 41,464 | 55,512 | 55,577 | 55,512 | 55,577 |


#### Sidebar

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| expand large folder: time | 186 ms (max 198 ms) | 776 ms (max 786 ms) | 1,098 ms (max 1,116 ms) | 1,116 ms (max 1,121 ms) | 1,112 ms (max 1,137 ms) | 1,216 ms (max 1,236 ms) |
| expand large folder: sidebar rows after | 700 | 3,500 | 5,005 | 5,005 | 5,005 | 5,005 |
| filter "report": time to first results | 139 ms (max 168 ms) | 571 ms (max 571 ms) | 1,110 ms (max 1,245 ms) | 6,103 ms (max 6,461 ms) | 1,105 ms (max 1,146 ms) | 6,171 ms (max 6,220 ms) |
| filter "report": result rows | 1,001 | 5,001 | 10,001 | 50,001 | 10,001 | 50,001 |
| filter "report": DOM elements | 5,641 | 27,127 | 54,179 | 271,908 | 54,179 | 271,908 |


#### Full-text search

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| common English: query | latency | latency | latency | latency | latency | latency |
| common English: cold, first results | 9,694 ms (max 9,722 ms) | 28.2 s (max 28.2 s) | 51.4 s (max 51.5 s) | 241.2 s (max 241.2 s) | 6,102 ms (max 6,105 ms) | 18.4 s (max 18.8 s) |
| common English: warm, first results | 5,309 ms (max 5,348 ms) | 23.8 s (max 23.8 s) | 47.0 s (max 47.1 s) | 236.8 s (max 236.9 s) | 884 ms (max 919 ms) | 2,376 ms (max 2,558 ms) |
| common English: hits | 404 | 2,002 | 4,055 | 20,254 | 4,055 | 20,254 |
| common English: cold, shard fetches | 14 | 7 | 7 | 6 | 7 | 6 |
| common English: cold, transferred | 149.1 kB | 235.2 kB | 419.4 kB | 1.92 MB | 323.2 kB (max 323.2 kB) | 1.08 MB (max 1.08 MB) |
| common English: warm, shard fetches | 14 | 7 | 7 | 6 | 7 | 6 |
| common English: warm, transferred | 149.1 kB | 235.2 kB | 419.4 kB | 1.92 MB | 340 B (max 414 B) | 348 B (max 391 B) |
| Japanese: query | 再試行 | 再試行 | 再試行 | 再試行 | 再試行 | 再試行 |
| Japanese: cold, first results | 10.2 s (max 10.2 s) | 28.7 s (max 28.7 s) | 52.1 s (max 52.1 s) | 242.6 s (max 242.8 s) | 6,646 ms (max 6,673 ms) | 19.7 s (max 19.9 s) |
| Japanese: warm, first results | 5,766 ms (max 5,779 ms) | 24.4 s (max 24.4 s) | 47.6 s (max 47.7 s) | 238.2 s (max 238.2 s) | 877 ms (max 939 ms) | 2,203 ms (max 2,251 ms) |
| Japanese: hits | 167 | 779 | 1,576 | 7,975 | 1,576 | 7,975 |
| Japanese: cold, shard fetches | 30 | 32 | 30 | 28 | 30 | 28 |
| Japanese: cold, transferred | 140.4 kB | 327.0 kB | 509.2 kB | 2.20 MB | 414.1 kB (max 414.1 kB) | 1.36 MB (max 1.36 MB) |
| Japanese: warm, shard fetches | 30 | 32 | 30 | 28 | 30 | 28 |
| Japanese: warm, transferred | 140.4 kB | 327.0 kB | 509.2 kB | 2.20 MB | 342 B (max 357 B) | 424 B (max 430 B) |
| rare: query | quokkaflux | quokkaflux | quokkaflux | quokkaflux | quokkaflux | quokkaflux |
| rare: cold, first results | 9,652 ms (max 9,693 ms) | 28.2 s (max 28.2 s) | 51.4 s (max 51.4 s) | 241.1 s (max 241.3 s) | 6,045 ms (max 6,117 ms) | 18.3 s (max 18.3 s) |
| rare: warm, first results | 5,235 ms (max 5,236 ms) | 23.8 s (max 23.8 s) | 47.1 s (max 47.1 s) | 236.8 s (max 237.0 s) | 873 ms (max 904 ms) | 2,301 ms (max 2,347 ms) |
| rare: hits | 7 | 7 | 7 | 7 | 7 | 7 |
| rare: cold, shard fetches | 11 | 11 | 11 | 8 | 11 | 8 |
| rare: cold, transferred | 119.0 kB | 271.4 kB | 447.1 kB | 1.93 MB | 351.2 kB (max 351.2 kB) | 1.10 MB (max 1.10 MB) |
| rare: warm, shard fetches | 11 | 11 | 11 | 8 | 11 | 8 |
| rare: warm, transferred | 119.0 kB | 271.4 kB | 447.1 kB | 1.93 MB | 367 B (max 400 B) | 349 B (max 352 B) |
| no hit: query | zzqxnohit | zzqxnohit | zzqxnohit | zzqxnohit | zzqxnohit | zzqxnohit |
| no hit: cold, first results | 9,486 ms (max 9,487 ms) | 28.0 s (max 28.0 s) | 51.2 s (max 51.2 s) | 240.9 s (max 240.9 s) | 5,827 ms (max 5,838 ms) | 18.2 s (max 18.3 s) |
| no hit: warm, first results | 5,082 ms (max 5,185 ms) | 23.6 s (max 23.6 s) | 46.8 s (max 46.9 s) | 236.5 s (max 236.5 s) | 853 ms (max 891 ms) | 2,295 ms (max 2,427 ms) |
| no hit: hits | 0 | 0 | 0 | 0 | 0 | 0 |
| no hit: cold, shard fetches | 2 | 2 | 2 | 2 | 2 | 2 |
| no hit: cold, transferred | 49.4 kB | 108.3 kB | 181.5 kB | 1.22 MB | 84.8 kB (max 84.8 kB) | 382.6 kB (max 382.6 kB) |
| no hit: warm, shard fetches | 2 | 2 | 2 | 2 | 2 | 2 |
| no hit: warm, transferred | 49.4 kB | 108.3 kB | 181.5 kB | 1.22 MB | 299 B (max 324 B) | 302 B (max 381 B) |


#### Heap

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 | Cloudflare 10,000 | Cloudflare 50,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| peak heap during the site session | 21.41 MB (max 21.84 MB) | 77.08 MB (max 77.57 MB) | 103.42 MB (max 104.45 MB) | 217.77 MB (max 218.11 MB) | 106.69 MB (max 112.86 MB) | 181.97 MB (max 182.00 MB) |
| heap after GC at end of session | 10.30 MB (max 10.30 MB) | 34.58 MB (max 34.58 MB) | 48.67 MB (max 48.70 MB) | 73.64 MB (max 73.67 MB) | 48.53 MB (max 48.69 MB) | 73.48 MB (max 73.55 MB) |
| peak heap, cold search (common English) | 8.28 MB (max 8.29 MB) | 17.43 MB (max 17.61 MB) | 17.66 MB (max 20.02 MB) | 74.19 MB (max 74.28 MB) | 22.86 MB (max 22.93 MB) | 87.13 MB (max 87.31 MB) |
| heap after GC, cold search (common English) | 5.74 MB (max 5.74 MB) | 8.45 MB (max 8.45 MB) | 13.20 MB (max 13.20 MB) | 47.10 MB (max 47.18 MB) | 13.26 MB (max 13.26 MB) | 47.12 MB (max 47.12 MB) |


#### Visiting every local site in sequence: scale-1000, scale-5000, scale-10000, scale-50000

| Step | open time | heap after GC |
| --- | ---: | ---: |
| / | - | 42.85 MB (max 42.86 MB) |
| scale-1000 | 4,188 ms | 43.50 MB (max 43.50 MB) |
| / (after scale-1000) | 29 ms | 3.90 MB (max 3.90 MB) |
| scale-5000 | 22.3 s | 7.46 MB (max 7.46 MB) |
| / (after scale-5000) | 31 ms | 6.40 MB (max 6.40 MB) |
| scale-10000 | 45.2 s | 13.14 MB (max 13.14 MB) |
| / (after scale-10000) | 32 ms | 3.42 MB (max 3.42 MB) |
| scale-50000 | 229.5 s | 36.14 MB (max 36.14 MB) |
| / (after scale-50000) | 33 ms | 34.10 MB (max 34.10 MB) |
| / (after 35 s idle) | - | 4.06 MB (max 4.06 MB) |
| peak heap over the sequence | | 47.15 MB (max 47.33 MB) |

First load of `/` in the same setup: cold 4,875 ms list visible, 60.42 MB transferred; warm 699 ms, 59.60 MB.


#### Visiting both Cloudflare sites in sequence: bench-10k, bench-50k

| Step | open time | heap after GC |
| --- | ---: | ---: |
| / | - | 39.29 MB (max 39.30 MB) |
| bench-10k | 313 ms | 40.48 MB (max 40.48 MB) |
| / (after bench-10k) | 45 ms | 39.85 MB (max 39.85 MB) |
| bench-50k | 1,331 ms | 41.96 MB (max 41.96 MB) |
| / (after bench-50k) | 43 ms | 39.94 MB (max 39.94 MB) |
| / (after 35 s idle) | - | 39.94 MB (max 39.94 MB) |
| peak heap over the sequence | | 61.33 MB (max 61.38 MB) |

First load of `/` in the same setup: cold 2,241 ms list visible, 3.06 MB transferred; warm 816 ms, 43.0 kB.

### Extended local phase, 2026-10-17

This phase adds the measurements the first local phase lacked: a time to interactive proxy, the first Mermaid render, main-thread long tasks, and seven search cases at 50,000 pages. It was run on a later build and a regenerated data set (see [Test conditions](#test-conditions) and [Data shape](#data-shape)), so its first-load numbers are not comparable cell by cell with the 2026-10-14 tables above. All numbers come from local nginx; Cloudflare was not re-run for these cases.

Definitions used by the harness:

- **Time to interactive proxy**: the start of the first window of 5,000 ms in which the page had no network activity and no main-thread long task (document complete, first contentful paint seen, at most 2 requests pending), never earlier than first contentful paint. It is a proxy, not the Lighthouse metric. The harness polls every 100 ms, so each value has about ±100 ms resolution. **The two runs behind these tables recorded the moment the quiet window was confirmed, which adds 5,000 ms to every value (a harness bug fixed afterwards). The tables therefore show the recorded value minus 5,000 ms.**
- **First Mermaid render**: navigation to a Markdown page (`overview-0.md`, one `flowchart` block) until the rendered SVG is present and two animation frames have been painted. The page opens through the normal site route, so the cost includes loading the site index and the lazily loaded Mermaid code. If the reader shows "Unable to load this site" instead, the harness records that failure and the time it appeared.
- **Long tasks**: main-thread tasks of 50 ms or more reported by the browser's Long Tasks API. Counts and durations are summed over the stated window (navigation until settled for Mermaid; route change until settled for search).
- **Search cases** run in one open search workspace of the 50,000-page site, one case after another, so later cases reuse search files that earlier cases already fetched. "First results" is measured from the route change inside the open workspace until the first result rows are painted; unlike the "Full-text search" tables above, it does not include opening the site. The cases ran in the order listed below, 3 iterations, unthrottled, cold session each iteration.

The first run (unthrottled, all sizes, plus the search cases) started at 12:22 UTC and stopped on the constrained profile at 5,000 pages (Mermaid); the second run (constrained, all sizes) ran from 13:05 UTC. Both use the same data set and build, so the unthrottled tables come from the first run and the constrained tables from the second. The committed [sanitized JSON](web-scale-benchmark-results.json) holds exactly these two sets.

#### First load of /, extended phase

Unthrottled:

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 |
| --- | ---: | ---: | ---: | ---: |
| cold: first contentful paint | 88 ms (max 788 ms) | 76 ms (max 80 ms) | 76 ms (max 80 ms) | 76 ms (max 80 ms) |
| cold: site list visible | 79 ms (max 157 ms) | 70 ms (max 71 ms) | 69 ms (max 79 ms) | 72 ms (max 77 ms) |
| cold: time to interactive proxy (recorded value minus 5,000 ms) | 131 ms (max 156 ms) | 139 ms (max 151 ms) | 112 ms (max 133 ms) | 117 ms (max 124 ms) |
| cold: transferred, total after settling | 840.8 kB | 840.3 kB | 840.4 kB | 840.4 kB |
| cold: requests | 6 | 6 | 6 | 6 |
| cold: entry JS transferred | 769.2 kB | 769.2 kB | 769.2 kB | 769.2 kB |
| cold: index requests transferred | 1.7 kB | 1.3 kB | 1.3 kB | 1.3 kB |
| warm: first contentful paint | 88 ms (max 112 ms) | 92 ms (max 96 ms) | 88 ms (max 164 ms) | 92 ms |
| warm: site list visible | 88 ms (max 111 ms) | 90 ms (max 92 ms) | 84 ms (max 176 ms) | 89 ms (max 91 ms) |
| warm: time to interactive proxy (recorded value minus 5,000 ms) | 154 ms (max 165 ms) | 123 ms (max 164 ms) | 134 ms (max 216 ms) | 132 ms (max 144 ms) |
| warm: transferred, total after settling | 2.2 kB | 1.8 kB | 1.8 kB | 1.8 kB |
| warm: requests | 6 | 6 | 6 | 6 |
| warm: entry JS transferred | 0 B | 0 B | 0 B | 0 B |
| warm: index requests transferred | 1.7 kB | 1.3 kB | 1.3 kB | 1.3 kB |

Constrained (CPU x4, 150 ms RTT, 1.6 Mbps down):

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 |
| --- | ---: | ---: | ---: | ---: |
| cold: first contentful paint | 4,948 ms | 4,928 ms (max 4,940 ms) | 4,932 ms (max 4,944 ms) | 4,928 ms (max 4,940 ms) |
| cold: site list visible | 4,987 ms (max 4,996 ms) | 4,971 ms (max 4,981 ms) | 4,983 ms (max 4,985 ms) | 4,977 ms (max 4,984 ms) |
| cold: time to interactive proxy (recorded value minus 5,000 ms) | 4,996 ms (max 5,005 ms) | 4,972 ms (max 4,973 ms) | 4,983 ms (max 4,991 ms) | 4,978 ms (max 4,990 ms) |
| cold: transferred, total after settling | 840.8 kB | 840.3 kB | 840.4 kB | 840.4 kB |
| cold: requests | 6 | 6 | 6 | 6 |
| cold: entry JS transferred | 769.2 kB | 769.2 kB | 769.2 kB | 769.2 kB |
| cold: index requests transferred | 1.7 kB | 1.3 kB | 1.3 kB | 1.3 kB |
| warm: first contentful paint | 612 ms (max 624 ms) | 616 ms (max 624 ms) | 612 ms (max 676 ms) | 628 ms (max 632 ms) |
| warm: site list visible | 668 ms (max 676 ms) | 664 ms (max 671 ms) | 676 ms (max 721 ms) | 681 ms (max 684 ms) |
| warm: time to interactive proxy (recorded value minus 5,000 ms) | 697 ms (max 698 ms) | 664 ms (max 688 ms) | 688 ms (max 741 ms) | 686 ms (max 692 ms) |
| warm: transferred, total after settling | 2.2 kB | 1.8 kB | 1.8 kB | 1.8 kB |
| warm: requests | 6 | 6 | 6 | 6 |
| warm: entry JS transferred | 0 B | 0 B | 0 B | 0 B |
| warm: index requests transferred | 1.7 kB | 1.3 kB | 1.3 kB | 1.3 kB |

In this build the site list loads only `sites.json` and the site's `meta.json` (about 1.3 kB), so the first load of `/` is the same at every site size: 840 kB cold, of which 769 kB is the entry JS (uncompressed locally). The 2026-10-14 tables above transferred the full `index.json` here (815.8 kB plus up to 45.5 MB); that behaviour changed between the two builds (see the Notes). The unthrottled cold first contentful paint at 1,000 pages has one 788 ms sample against a median of 88 ms; it was not investigated.

#### First Mermaid render

Unthrottled:

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 |
| --- | ---: | ---: | ---: | ---: |
| cold: first Mermaid render | 260 ms (max 316 ms) | 359 ms (max 364 ms) | 418 ms (max 426 ms) | 1,369 ms (max 1,446 ms) |
| cold: transferred, total after settling | 2.42 MB | 6.03 MB | 10.56 MB | 47.54 MB |
| cold: requests | 35 | 35 | 35 | 35 |
| cold: main-thread long tasks, count | 0 | 1 | 1 | 3 |
| cold: long tasks, total duration | 0 ms | 89 ms (max 91 ms) | 152 ms (max 155 ms) | 888 ms (max 907 ms) |
| cold: longest long task | 0 ms | 89 ms (max 91 ms) | 152 ms (max 155 ms) | 763 ms (max 781 ms) |
| warm: first Mermaid render | 153 ms (max 166 ms) | 233 ms (max 234 ms) | 336 ms | 1,184 ms (max 1,267 ms) |
| warm: transferred, total after settling | 784.2 kB | 4.39 MB | 8.93 MB | 45.90 MB |
| warm: requests | 35 | 35 | 35 | 35 |
| warm: main-thread long tasks, count | 0 | 1 | 1 | 2 (max 3) |
| warm: long tasks, total duration | 0 ms | 67 ms (max 74 ms) | 136 ms | 807 ms (max 843 ms) |
| warm: longest long task | 0 ms | 67 ms (max 74 ms) | 136 ms | 723 ms (max 736 ms) |

Constrained (CPU x4, 150 ms RTT, 1.6 Mbps down):

| Measurement | Local 1,000 | Local 5,000 | Local 10,000 | Local 50,000 |
| --- | ---: | ---: | ---: | ---: |
| cold: first Mermaid render | 13.8 s (max 13.9 s) | failed ("Unable to load this site") at 24.6 s | failed ("Unable to load this site") at 24.6 s | failed ("Unable to load this site") at 24.6 s |
| cold: transferred, total after settling | 2.42 MB | 840.3 kB (aborted index request not counted) | 840.4 kB (aborted index request not counted) | 840.4 kB (aborted index request not counted) |
| cold: requests | 35 | 7 | 7 | 7 |
| cold: main-thread long tasks, count | 4 | not measured | not measured | not measured |
| cold: long tasks, total duration | 290 ms (max 294 ms) | not measured | not measured | not measured |
| cold: longest long task | 127 ms (max 130 ms) | not measured | not measured | not measured |
| warm: first Mermaid render | 4,736 ms (max 4,819 ms) | failed ("Unable to load this site") at 20.2 s | failed ("Unable to load this site") at 20.2 s | failed ("Unable to load this site") at 20.2 s (max 20.3 s) |
| warm: transferred, total after settling | 784.2 kB | 1.8 kB (aborted index request not counted) | 1.8 kB (aborted index request not counted) | 1.8 kB (aborted index request not counted) |
| warm: requests | 35 | 7 | 7 | 7 |
| warm: main-thread long tasks, count | 1 | not measured | not measured | not measured |
| warm: long tasks, total duration | 79 ms (max 114 ms) | not measured | not measured | not measured |
| warm: longest long task | 79 ms (max 114 ms) | not measured | not measured | not measured |

At 5,000, 10,000 and 50,000 pages under the constrained profile the reader did not render the diagram in any of the 3 cold or 3 warm visits. It showed "Unable to load this site / This site is taking too long to load. Try again in a moment." about 24.6 s after navigation on a cold visit and 20.2 s on a warm visit, and the request that was aborted was `/_indexes/<site>/index.json` in every case. The cold value is 4.6 s longer than the warm one because the entry JS (769 kB) had to be downloaded first. The cause was checked in the source: `SITE_INDEX_TIMEOUT_MS = 20_000` in `web/src/data/indexes.ts` bounds the whole site-index read, headers and body, and the reader does not extend or resume it. Local nginx serves `index.json` uncompressed (5,000 pages: 4.39 MB; 10,000: 8.92 MB; 50,000: 45.90 MB), and 4.39 MB at 1.6 Mbps takes about 22 s by arithmetic (4.39 MB x 8 / 1.6 Mbps), more than the 20 s limit. By the source, "Try again" starts a new request with a new 20 s budget, so it meets the same limit (the harness did not click it). Production on Cloudflare delivers the index brotli-encoded (the 50,000-page index gzips to 2.63 MB at level 9; about 13 s at 1.6 Mbps by the same arithmetic, and above 20 s below roughly 1 Mbps), so this failure was observed with local, uncompressed delivery only. See [ISSUE-110](../backlog/issues/ISSUE-110-site-index-deadline-covers-body-download.md).

The bytes of the aborted request are not counted in the "transferred" cells of the failed visits.

#### Search cases at 50,000 pages

Opening the search workspace of the 50,000-page site (before any query) mounted in 646 ms (max 673 ms), with 7 requests and 46.74 MB transferred (the site index), settled after 1,470 ms (max 1,498 ms); no search file was fetched at that point. Unthrottled, 3 iterations:

| Case | Query | Result count text | First results | Rows | Search files fetched | Search bytes | Fetched by kind (count, bytes) | Long tasks (count, total, longest) |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| many hits | `latency` | 20,254 pages contain "latency" | 282 ms (max 305 ms) | 20 | 6 | 1.93 MB | manifest 1 (950.2 kB), root 1 (261.4 kB), leaf 1 (15.0 kB), sections 1 (681.6 kB), text 2 (19.6 kB) | 2, 159 ms (max 162 ms), 99 ms (max 102 ms) |
| few hits | `quokkaflux` | 7 pages contain "quokkaflux" | 74 ms (max 90 ms) | 7 | 5 | 40.7 kB | leaf 1 (7.7 kB), text 4 (33.0 kB) | 0, 0 ms, 0 ms |
| Japanese | `再試行` | 7,975 pages contain "再試行" | 118 ms (max 126 ms) | 20 | 20 | 265.9 kB | leaf 20 (265.9 kB) | 0, 0 ms, 0 ms |
| long body | `longbodyprobe` | 1 page contains "longbodyprobe" | 90 ms (max 105 ms) | 1 | 0 | 0 B | none | 0, 0 ms, 0 ms |
| folder filtered | `generationprobe` | 20 pages in 000-generation/ so far, among 20 of 525 pages that contain "generationprobe" | 91 ms (max 104 ms) | 20 | 2 | 23.6 kB | leaf 2 (23.6 kB) | 0, 0 ms, 0 ms |
| vanished generation (before republish) | `vanishedgenerationprobe` | 525 pages contain "vanishedgenerationprobe" | 90 ms (max 94 ms) | 20 | 0 | 0 B | none | 0, 0 ms, 0 ms |

"Search files fetched" counts requests under `/_indexes/<site>/search/` between the route change and the settled page; the fetched-by-kind column gives the same files by kind (`manifest`, `root`, `leaf`, `sections`, `text`) with their transferred bytes. The first case pays for the manifest, root, sections and leaf files; later cases fetched fewer files, and the long-body and vanished-generation cases fetched none, which is consistent with those results being served from files the earlier cases had already loaded (an inference from the request counts, not a separate check). The count text of the folder-filtered case is shown as the reader printed it: the folder filter applies to the hits found so far.

Paging, and the vanished generation after republishing:

| Step | Time | Rows | Result count text and button | Requests | Bytes | Long tasks (count, total, longest) |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| common-term second page ("Show 20 more") | 962 ms (max 964 ms) | 40 | 20,254 pages contain "latency"; button "Show 20 more (40 of 20254 shown)" | 2 | 17.3 kB | 0, 0 ms, 0 ms |
| vanished-generation query, second page (before republish) | 910 ms (max 912 ms) | 40 | 525 pages contain "vanishedgenerationprobe"; button "Show 20 more (40 of 525 shown)" | 0 | 0 B | 0, 0 ms, 0 ms |
| after republish and 61 s: "Show 20 more" to 60 rows | 1,288 ms (max 1,321 ms) | 60 | 524 pages contain "vanishedgenerationprobe"; button "Show 20 more (60 of 524 shown)" | 7 | 1.94 MB | 2, 197 ms (max 236 ms), 121 ms (max 155 ms) |

The "Time" of the paging steps ends after the harness's 800 ms quiet wait, so each value includes at least 0.8 s of waiting; the request and byte columns are the better comparison. Observed behaviour of the vanished-generation case, in all 3 iterations: the query was run (525 hits, 20 rows), the second page was opened (40 rows, path order), the search data was then replaced by a republished version in which one page no longer contains the term, and after 61 s (the harness waits this long so that cached search data can expire) "Show 20 more" was used. The reader fetched the new manifest, root, leaf, sections and 3 text packs (7 requests, 1.94 MB), showed the new count (524 pages) and 60 rows starting again from the beginning of the path order (first row `000-generation/target-001.md`), and displayed no error. The long-task counts in the table are for that refresh.

#### Snippet budget at 50,000 pages

The manifest of the 50,000-page site records `snippetLimits.maxSiteBytes` 33,554,432 (32 MiB) and `maxDocumentBytes` 262,144 (256 KiB). 18,956 of its 50,308 documents are listed in `omittedDocuments` (no snippet) and 0 in `truncatedDocuments`. The long-body probe page (`big-flat/page-000000.md`, 281,101 B, above the per-document cap) is among the omitted documents: the site budget omits it before the per-document cap applies, so it shows a result without a snippet and the "truncated" path was not exercised. Omission follows path order: the first omitted document is `area-13/section-040/note-023.md` and the last ones are the root `overview-*` pages, so the documents that sort later lose snippets first. The largest text pack is 77,553 B raw. See [ISSUE-111](../backlog/issues/ISSUE-111-snippet-budget-omits-late-documents-at-scale.md).

## Notes

Observations only; none of them is a judgement.

- In the 2026-10-14 local build and in web 0.3.2, the site list (`/`) fetched `index.json` of every registered site, not only `meta.json`. In the extended local phase (a later build that reads counts and freshness from discovery metadata, [ISSUE-095](../backlog/issues/ISSUE-095-home-folder-counts-load-full-indexes.md)) the first load of `/` fetched only `sites.json` and `meta.json` and transferred 840 kB cold at every size. The rest of this note describes the earlier behaviour. Cold, this makes the transfer of `/` grow with the registered sites' sizes (local 50,000: 46.3 MB transferred; local sequence with all four sites registered: about 60 MB). This is the behaviour recorded in [ISSUE-095](../backlog/issues/ISSUE-095-home-folder-counts-load-full-indexes.md). Production web 0.3.2 on Cloudflare behaves the same way for the two bench sites; its cold `/` transfers 3.1 MB because the verification environment also registers other, smaller sites and the responses are brotli-encoded.
- Compression changes the transferred bytes, not the decoded bytes. Local nginx served `index.json` uncompressed (45.5 MB at 50,000 pages); Cloudflare served the same data brotli-encoded (2.3 MB). The constrained profile at 1.6 Mbps therefore opens a 50,000-page site in 234.1 s locally and 15.4 s on Cloudflare. In the unthrottled profile the two are within about 0.3 s of each other at 50,000 pages for the rendered home. Delivery path, client location and web version all differ between the two phases, so the columns are not a controlled comparison of the web version.
- Warm visits: locally, a warm visit transferred the full `index.json` again (45.5 MB at 50,000 pages) and only the entry JS came from cache. On Cloudflare, a warm visit transferred 341 B for `index.json`.
- Entry JS is 748.6 kB raw in both builds of the first two phases (768.9 kB raw in the extended local build): 748.9 kB transferred locally, about 234 kB transferred from Cloudflare.
- Directory page of the 5,000-page folder without a README renders one DOM row per page (5,000 rows, about 99,400 DOM elements). The folder with a README shows 10 rows first and 500 after "Show all" ([ISSUE-093](../backlog/issues/ISSUE-093-directory-and-sidebar-render-every-row.md)). The sidebar filter "report" matches every page of the site and rendered 1,001 / 5,001 / 10,001 / 50,001 rows (about 272,000 DOM elements at 50,000 pages).
- Search fetches 2-32 shard files per query (manifest, root, leaf, section and text packs); the no-hit query fetched 2. The folder-filter, paging, vanished-generation, long-body and Mermaid cases were measured in the extended local phase, at 50,000 pages and unthrottled only.
- Heap: after opening a 50,000-page site the heap after GC was about 36 MB locally and on Cloudflare. The sequence tables show the heap after visiting the sites one after another from the site list. The first `/` reading was about 44 MB unthrottled and about 43 MB constrained. The constrained run dropped to about 4 MB later in the sequence and after the 35 s idle window; the unthrottled run stayed at about 44-47 MB through the idle window. The cause was not investigated (see [ISSUE-094](../backlog/issues/ISSUE-094-site-index-cache-never-evicts.md) for the index cache).
- Three iterations give a median and a maximum, not a distribution. A few cells have a maximum far above the median (for example the first Cloudflare unthrottled cold load at 10,000 pages, 1,144 ms maximum against 332 ms median), which was not investigated.
- Not measured: a low-end physical device (CPU throttling x4 is an emulation); the extended search cases (folder filter, paging, long body, vanished generation) under the constrained profile, because the 45.90 MB uncompressed local `index.json` meets the 20 s site-index deadline there; a Cloudflare re-run of the time to interactive proxy, the first Mermaid render and the extended search cases; sites above 50,000 pages; other regions or networks; and a controlled comparison of web 0.3.2 against the unreleased build on the same delivery path.
- Extended local phase: the time to interactive proxy values are the recorded value minus the 5,000 ms quiet window, with about ±100 ms polling resolution. At 5,000 pages and above, the constrained first Mermaid render failed in every visit because of the 20 s site-index deadline with uncompressed delivery ([ISSUE-110](../backlog/issues/ISSUE-110-site-index-deadline-covers-body-download.md)). At 50,000 pages 18,956 of 50,308 documents have no search snippet because of the 32 MiB site budget ([ISSUE-111](../backlog/issues/ISSUE-111-snippet-budget-omits-late-documents-at-scale.md)). Search and Mermaid numbers come from 3 iterations on one machine.
- The harness stores no result files in Git; per-iteration samples are under the untracked `.local/web-scale/`.
