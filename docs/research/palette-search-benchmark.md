# Site-local palette search benchmark

Date: 2026-09-25

This benchmark measures the current browser product's site-local artifact search. Typing is simulated one character per input event (`atlas`), with a paint opportunity between keystrokes. Fixtures are deterministic, synthetic, and generated under ignored `.local/`; timings are from local headless Chromium and are not a prediction of CDN or public-network latency.

## Reproduce

```sh
npm run build
node scripts/benchmark-palette.mjs --counts 20000 --chunk-sizes 250,1000,5000 --iterations 5 --loads 3 --seed sequential-chunk-trial-20260925
node scripts/benchmark-palette.mjs --counts 20000 --iterations 10 --loads 3 --seed sequential-chunk-trial-20260925
node scripts/benchmark-palette.mjs --sites 20 --artifacts-per-site 1000 --iterations 10 --loads 3 --seed sequential-multisite-20260925
node scripts/benchmark-palette.mjs --counts 100000 --iterations 5 --loads 3 --seed indexed-search-scale-20260925
node scripts/benchmark-palette.mjs --counts 20000,100000 --sites 20 --artifacts-per-site 1000 --recent-reads 0 --iterations 5 --loads 3 --seed recent-history-scale-20260926
node scripts/benchmark-palette.mjs --counts 20000,100000 --sites 20 --artifacts-per-site 1000 --recent-reads 20 --iterations 5 --loads 3 --seed recent-history-scale-20260926
node scripts/benchmark-palette.mjs --sites 1000 --artifacts-per-site 20 --recent-reads 0 --iterations 5 --loads 3 --seed recent-history-max-sites-20260926
node scripts/benchmark-palette.mjs --sites 1000 --artifacts-per-site 20 --recent-reads 20 --iterations 5 --loads 3 --seed recent-history-max-sites-20260926
```

`--chunk-sizes` enables a benchmark-only fetch adapter: it eagerly downloads every artifact chunk and reassembles the same complete `SiteIndex` before rendering. It does not change the product index contract.

## Results

| Scenario | Current-site index bytes | Detail requests | Ready-to-use p50 | Detail JSON parse p50 | Aggregate body-read p50 | Heap after search p50 | Search JS by typed character (p50) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 site × 20,000, monolithic | 9.85 MB | 1 | 606 ms | 7.0 ms | 27 ms | 80.48 MB | `a` 9.6, `t` 9.4, `l` 6.6, `a` 2.7, `s` 1.4 ms |
| Eager chunks of 250 | 9.85 MB (+3.8 KB manifests) | 81 | 607 ms | 7.7 ms | 180 ms | 81.05 MB | `a` 9.7, `t` 9.3, `l` 6.3, `a` 2.6, `s` 1.4 ms |
| Eager chunks of 1,000 | 9.85 MB (+0.9 KB manifests) | 21 | 606 ms | 7.5 ms | 138 ms | 81.02 MB | `a` 9.5, `t` 9.0, `l` 6.4, `a` 2.6, `s` 1.4 ms |
| Eager chunks of 5,000 | 9.85 MB (+0.2 KB manifests) | 5 | 621 ms | 6.6 ms | 62 ms | 80.49 MB | `a` 9.7, `t` 9.6, `l` 6.6, `a` 2.6, `s` 1.3 ms |
| 20 sites × 1,000, current site active | 486 KB active index; 3.7 KB all metadata | 1 index + 20 metadata | 107.8 ms | 0.5 ms | — | 5.74 MB | `a` 2.0, `t` 1.8, `l` 1.1, `a` 0.9, `s` 0.7 ms |

Values for chunk variants are medians across three full navigations with the same deterministic 20,000-artifact seed. The memory column is Chromium JS heap after search and forced garbage collection. `Aggregate body-read` sums response-body read durations; with concurrent chunks, these overlap and are not elapsed wall time. Input-to-paint uses a double-`requestAnimationFrame` probe (about 31–35 ms here), so treat it as a consistent UI responsiveness proxy, not a hardware paint timestamp.

For the same 20,000-artifact seed and payload, the prior palette search implementation measured about 94.39 MB after search and 66.4 ms for the cold first key. The new implementation measured about 80.48 MB and 30.7 ms: approximately 13.9 MB (14.7%) less retained heap and 54% less cold-key JS time. In later keystrokes, the candidate set narrows monotonically while the user extends a query; the last two characters fell to about 1–3 ms. Backspace or a non-prefix edit falls back to a complete current-site scan.

The search-only cache now keeps compact normalized strings rather than per-word object graphs. It computes scores without constructing match-position arrays for every artifact, and generates highlighted positions only for the eight displayed results.

## Chunking decision

Eagerly fetching all chunks did not reduce bytes, steady-state heap, or sequential-search time because the app still needs every current-site artifact to provide complete search and browsing. Ready-to-use time stayed within run-to-run noise (606 ms monolithic; 607/606/621 ms for 250/1,000/5,000 chunks), while request count rose from 1 to 81/21/5. At 250 and 1,000 records per chunk, aggregate body-read time rose substantially; the 5,000-record variant came closest to the monolith but still showed no user-visible benefit. Do not add eager index sharding to the product contract yet.

If real sites materially exceed this envelope, the next experiment should reduce the data retained by the browser (for example, a compact navigation/search projection with non-search details loaded only when needed), then measure its impact on direct artifact navigation and Details/Contents. A shard or inverted index should follow only if that experiment still leaves a user-visible bottleneck.

## Browse virtualization and search-structure experiments

The earlier 20,000-artifact table above predates virtualization of the Site Home Browse list. The full site index is still loaded for the active site, but the Browse list now mounts only the viewport rows plus a small overscan window. The benchmark scrolls to the bottom and verifies the final row, so this is not a truncated-results shortcut.

| Scenario | Site-home ready p50 | Active detail index | Initial Browse artifact rows | Heap after site load p50 | Heap after palette search p50 | Search responsiveness |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 site × 20,000, before virtualization | ~640 ms | 9.85 MB | 20,000 | 76.58 MB | 81.35 MB | cold first-key input-to-paint ~50 ms |
| 1 site × 20,000, virtualized | 157.1 ms | 9.85 MB | 15 of 20,000 | 19.49 MB | 23.66 MB | first `a` JS p50 ~11 / p95 ~25 ms; input-to-paint p50 ~34 ms |
| 1 site × 100,000, virtualized | 406.4 ms | 49.21 MB | 15 of 100,000 | 72.72 MB | 90.23 MB | first `a` JS p50 ~41 / p95 ~110 ms; input-to-paint p50 ~51 / p95 ~116 ms |
| 20 sites × 1,000, active site loaded | 107.8 ms | 486 KB active; 3.72 KB discovery metadata total | 15 of 1,000 | 4.67 MB | 5.74 MB | site-local first-key JS p50 ~2 ms; `@site-0020` works |

The 20,000-artifact DOM fell from about 144,379 CDP nodes to about 504 (roughly 99.65% fewer). Across the latest three-navigation run, readiness was 157.1 ms versus about 640 ms before virtualization (about 75% lower); retained heap after palette search fell about 71%. The 20,000-artifact run used 10 one-character typing repetitions per query and three navigations. The 100,000-artifact run used five repetitions per query across three navigations; it is a scale indicator, not a CDN/network forecast. Its first character remains too expensive for a reliably fluid palette.

The latest multi-site run used three navigations and 10 one-character typing repetitions per query. It fetched all 20 lightweight metadata documents (3.72 KB total) and exactly one detailed index (486 KB), for the active site. Palette searches including `@site-0020` found their result. Median site-home readiness was 107.8 ms (range 105.3–109 ms), detail-index parsing was about 0.5 ms, and the active site retained about 4.7 MB after load / 5.7 MB after palette search. Search JS for the first character was about 2 ms p50 (about 3.4 ms p95). This confirms that 20 × 1,000 does not behave like loading 20 detailed indexes: the other 19 sites contribute only lightweight discovery metadata until selected.

### Recent-read footprint and contextual scoring (2026-09-26)

This comparison seeds either no history or 20 reads for each site. It opens a generated Markdown index entry through the palette, verifies that the route becomes the newest read, then opens the palette again with that document as context and types `atlas`. The fixtures contain indexes rather than artifact bodies. IDs match the indexer's route contract (`id` equals the artifact's relative path). History sizes below are serialized JSON UTF-8 bytes; heap is Chromium's JS heap after forced garbage collection. Timings are medians across three navigations.

| Scenario | Seeded reads | Serialized history | Active site index | Site ready p50 | Heap after palette search p50 | Site-home first `a` JS p50 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 site × 20,000, no history | 0 | 0 B | 10.89 MB | 139.5 ms | 24.77 MB | 14.4 ms |
| 1 site × 20,000, 20 reads | 20 | 2,199 B | 10.89 MB | 143.0 ms | 24.79 MB | 16.4 ms |
| 1 site × 100,000, no history | 0 | 0 B | 54.70 MB | 392.0 ms | 96.07 MB | 64.7 ms |
| 1 site × 100,000, 20 reads | 20 | 2,213 B | 54.70 MB | 358.9 ms | 96.11 MB | 65.7 ms |
| 20 sites × 1,000, no history | 0 | 0 B | 538 KB | 105.6 ms | 5.81 MB | 2.7 ms |
| 20 sites × 1,000, 20 reads/site | 400 | 44,273 B | 538 KB | 110.0 ms | 5.87 MB | 2.8 ms |

The added recent reads change first-key search by about 0–2 ms across these workloads, within run-to-run variation. The Recent scope showed the expected eight visible results from 20 stored entries. Opening an artifact also updated the stored order correctly.

The benchmark then measures palette open and first-character search both on Site Home and with a document open. The second state invokes the current-file path and shared-word scoring. The `a`/`atlas` query and index are otherwise the same within each row.

| Workload | Seeded reads/site | Palette open: Site Home | Palette open: document open | First `a` JS: Site Home | First `a` JS: document open | Document-open input-to-paint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 site × 20,000 | 0 | 49.8 ms | 105.3 ms | 14.4 ms | 62.9 ms | 83.4 ms |
| 1 site × 20,000 | 20 | 49.5 ms | 101.9 ms | 16.4 ms | 59.5 ms | 67.0 ms |
| 1 site × 100,000 | 0 | 145.7 ms | 319.3 ms | 64.7 ms | 308.7 ms | 320.0 ms |
| 1 site × 100,000 | 20 | 157.1 ms | 313.3 ms | 65.7 ms | 309.5 ms | 321.2 ms |
| 20 sites × 1,000 | 0 | 38.2 ms | 42.4 ms | 2.7 ms | 5.1 ms | 33.2 ms |
| 20 sites × 1,000 | 20 | 37.6 ms | 38.7 ms | 2.8 ms | 6.1 ms | 33.6 ms |

The context-scoring state is the search bottleneck for large single-site indexes. At 20,000 records, first-character JS time rises from 14–16 ms on Site Home to about 60–63 ms with a document open. At 100,000 records it rises from about 65 ms to 309 ms, with roughly 320 ms input-to-paint. Opening the palette with a document open takes 105 ms and 319 ms at these two sizes. By contrast, 20 reads add no material search delay. This is a same-build comparison of two product states, not a historical before/after build comparison.

The likely hot path includes per-candidate contextual scoring: `getSharedWordAffinity` builds token sets for every candidate, and `getPathAffinity` splits paths for every candidate. The empty-query palette also scores the full active-site index. In addition, each palette render filters the full artifact list three times to recalculate Recent, Pinned, and available-scope counts; the available-scope count still scans the full list for non-empty queries. The integrated matrices below measure these costs directly: CSR profiles eliminate repeated token/path feature construction without changing ranking, while Recent/Pinned prefiltering avoids scoring entries outside the selected scope.

An additional 1,000-site stress run used 20 artifacts/site and 20 reads/site (20,000 total reads). It stored 2,211,859 B of serialized history and added about 2.23 MB to median heap after site load and 2.24 MB after palette search. Site-ready p50 was 310.3 ms versus 322.6 ms with no history, while click-to-persist was 18.3 ms p50 and `localStorage.setItem` took 2.2 ms p50. All 1,000 discovery metadata files were fetched (184 KB); only the active site's 10.9 KB artifact index was loaded.

The product currently caps reads at 20 per site but has no global site/history limit. The 1,000-site case is a stress fixture, not a product maximum: total storage continues to grow with site count and artifact path length. Add a global eviction limit if deployments may accumulate substantially more than 1,000 sites.

These current measurements use route-shaped artifact IDs. Older tables in this document were captured with shorter synthetic IDs, so compare their relative behavior rather than raw index byte sizes with this section.

### Candidate-index prototype (benchmark only)

The proposal correctly separates transport chunking from search work. To test that distinction without changing the product contract, the benchmark now builds two temporary browser-side search projections from the already-loaded active-site records:

- **Character postings:** each normalized character maps to artifact IDs; intersect the postings for query characters, then run the existing fuzzy scorer on those candidates.
- **Sorted token dictionary:** binary-search the sorted title/path token dictionary for tokens beginning with each typed prefix, then run the fuzzy scorer on those candidates.

This prototype does not fetch shards over HTTP and is not production code. Its byte figures are uncompressed JSON estimates; retained-heap delta includes its temporary normalized corpus as well as posting/dictionary structures. Query quality compares the top eight results with the current fuzzy search. Inputs are typed one character at a time for `atlas`, fuzzy subsequence `pltfrm`, and a no-match query.

| Records | Strategy | JS p50 per typed character (`atlas`) | Final candidates for `atlas` | `atlas` top 8 unchanged? | `pltfrm` top 8 unchanged? | Added raw JSON / heap |
| ---: | --- | ---: | ---: | --- | --- | --- |
| 20,000 | Existing cached fuzzy scan | 5.0 ms | 1,250 | baseline | baseline | — |
| 20,000 | Character postings | 7.4 ms | 19,036 | yes | yes, but slower | 2.51 MB / ~9.93 MB |
| 20,000 | Sorted prefix dictionary | 0.6 ms | 1,250 | yes | **no results** (baseline returns 8) | 1.99 MB serialized; heap not isolated |
| 100,000 | Existing cached fuzzy scan | 24.6 ms | 6,250 | baseline | baseline | — |
| 100,000 | Character postings | 38.2 ms | 94,941 | yes | yes, but slower | 13.72 MB / ~50.18 MB |
| 100,000 | Sorted prefix dictionary | 3.2 ms | 6,250 | yes | **no results** (baseline returns 8) | 10.52 MB serialized; heap not isolated |

Character postings preserve the current top eight in these fixtures, but common first characters leave nearly every record as a candidate; building and intersecting those lists was slower than the current incremental fuzzy cache and retained substantially more memory. A prefix dictionary is fast for `atlas`, but it is not behavior-equivalent: it drops the intentional fuzzy subsequence match `pltfrm` → “Platform”. It therefore cannot replace search unless the product explicitly changes its matching contract.

Do not ship either projection or add network shards based on these results. The remaining measured bottleneck is early input on a single very large site, not the number of sites when only the active site index is loaded. The 5,000/10,000 trials confirmed that character postings remain slower and use more heap, while a sorted prefix dictionary still drops the `pltfrm` fuzzy match. Across the tested sizes, neither candidate structure offers an acceptable combination of ranking parity, memory, and speed. Keep transport chunking separate from candidate pruning: chunking alone did not improve ready-to-use time, and candidate pruning must preserve fuzzy matching.

### Precomputed contextual scoring profiles (benchmark only, 2026-09-26)

Reproduce the full-signal comparison with:

~~~sh
node scripts/benchmark-palette.mjs --counts 100000 --sites 20 --artifacts-per-site 1000 --recent-reads 20 --iterations 5 --loads 3 --seed context-signals-complete-20260926
~~~

This run used three browser navigations for each of two shapes: one active site with 100,000 artifacts, and 20 sites with 1,000 artifacts each (20,000 total, 1,000 in the active site). The large active index was 55.1 MB. The ranking phase receives the already-matched candidate list, so these numbers isolate scoring and top-eight selection after fuzzy matching.

Every strategy scored the query fit, contextual affinity to the open artifact, recent-read recency, pin boost, and freshness boost. The trial used a 24-point recency score halved for every 24 hours, +5 for a pin, +2 for an update within one day, and +1 for an update within seven days. It seeded 20 recent reads, 20 synthetic pin IDs, and two controlled freshness targets; the other large-index records were set to 30 days old. Each signal was also ablated separately to see whether it changed the top eight. All, Recent, and Pinned scopes returned identical top-eight IDs across every scoring strategy and query in all six navigations.

The table gives the median of the five per-navigation timing samples, then the median across three navigations. `Profile` stores per-artifact word and folder IDs. `CSR` computes contextual affinity from packed arrays. `Inverted` reads a precomputed current-document affinity vector. `+ signal vector` replaces per-candidate recent/pin/freshness calculations with one precomputed vector. Vector construction is excluded from these ranking timings.

| Query | Candidates | Raw | Profile | Profile + signal vector | CSR | CSR + signal vector | Inverted | Inverted + signal vector |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Empty | 99,999 | 232.0 ms | 26.0 ms | 8.8 ms | 24.7 ms | 7.7 ms | 17.6 ms | 1.2 ms |
| `a` | 97,468 | 228.4 ms | 25.3 ms | 8.6 ms | 23.8 ms | 7.5 ms | 17.7 ms | 1.2 ms |
| `atlas` | 6,250 | 15.4 ms | 2.2 ms | 0.7 ms | 1.3 ms | 0.5 ms | 0.7 ms | 0.1 ms |
| `pltfrm` | 6,250 | 15.1 ms | 2.2 ms | 0.7 ms | 1.2 ms | 0.5 ms | 0.7 ms | 0.1 ms |

No-match `zzzz` had no ranking candidates. On the 20-site shape, the active 1,000-record index completed the empty-query ranking in 2.5 ms with `Raw` and 0.2 ms or less with the precomputed approaches. The actual, unchanged product measured a median 37.7 ms to open the document palette and 5.6 ms for its first typed character; page-ready was 106 ms. At 100,000 records those product measurements were 305.7 ms to open, 306.5 ms for the first character, and 405.9 ms page-ready. The experimental scorer is not integrated, so these end-to-end product numbers did not improve.

#### Storage and setup cost at 100,000 artifacts

| Representation | Build/setup time | Serialized form | Retained browser memory |
| --- | ---: | ---: | ---: |
| Object profile | 201.6 ms | 3.84 MB JSON / 1.13 MB gzip | 11.53 MB V8 heap |
| CSR typed arrays | 6.0 ms after profiles exist | 2.97 MB binary / 1.51 MB gzip; expanded JSON is 4.60 MB / 1.51 MB gzip | 2.97 MB, almost entirely typed-array backing storage |
| Inverted postings, added to profile | 46.1 ms | 6.35 MB additional JSON / 2.59 MB additional gzip; full profile plus postings is 10.19 MB / 3.72 MB gzip | 10.44 MB additional V8 heap |

The CSR representation uses `Uint32Array` offsets and `Uint16Array` word/folder IDs. Packing from the already-built profiles took about 6 ms; the browser-side profile construction itself took about 202 ms in this prototype. The current document's contextual affinity vector was 100 KB and took 2.4 ms to build from postings. The combined recent/pin/freshness vector was a `Float64Array` of 800 KB and took 17.1 ms to build. That setup work must be measured on document changes or signal updates before integration; it is not part of per-keystroke ranking time. The object profile removes much of the hot-path work, while CSR stores its static features at roughly one quarter of the measured retained memory. The inverted index plus both score vectors is fastest here, but its posting representation has a substantial memory cost.

The signal ablation confirms that boosts can affect order independently of scope. In the 100,000-record corpus, recency changed the top eight for four of five queries; the selected pin and freshness boosts were applied, but did not displace the top eight for those query candidates. In the 1,000-record active-site corpus, recency and pin changed the top eight for four of five queries each, and freshness did so for two of five. This is data-dependent: a signal can be scored correctly without changing the visible order for a particular query.

#### Unicode parity

The benchmark also checks an 11-document corpus with Japanese text, astral characters such as `𠮷` and `😀`, and folder names containing dots. It exercises the source-equivalent fuzzy matcher (including astral-character scoring), not just token and path affinity. Across eight queries (`検索`, `東京`, `𠮷`, `guide`, `atl`, `tl`, `alpha`, and empty), it compared 121 ordered-pair context scores, 264 top-eight rankings across the profile/CSR/inverted alternatives, and 1,694 field/query scores. All scores and rankings matched in each of the six navigations; the `😀atlas` / `atl` fuzzy-score check returned 55.55.

#### What this supported before UI integration

The query-only comparison favored compact CSR profiles and a current-document affinity vector. The integrated tests below measure those tradeoffs at palette open and on each keystroke, including the cost of putting profiles in the site index. Candidate pruning is measured separately because it changes which records reach fuzzy matching.

### Integrated palette scoring and index profiles (2026-09-26)

These benchmark-only modes use the real `CommandPalette` component. Build the special bundle first; the options do not affect the normal build or product default:

~~~sh
npm run build -- --mode palette-bench
node scripts/benchmark-palette.mjs --counts 20000,100000 --sites 20 --artifacts-per-site 1000 --recent-reads 20 --iterations 5 --loads 3 --palette-score-matrix --seed integrated-scoring-matrix-final-20260926
node scripts/benchmark-palette.mjs --counts 20000,100000 --sites 20 --artifacts-per-site 1000 --recent-reads 20 --iterations 5 --loads 3 --palette-scope-matrix --seed scope-prefilter-balanced-20260926
node scripts/benchmark-palette.mjs --counts 20000,100000 --sites 20 --artifacts-per-site 1000 --recent-reads 20 --iterations 5 --loads 3 --palette-index-matrix --seed precomputed-index-matrix-20260926
node scripts/benchmark-palette.mjs --counts 20000 --recent-reads 20 --iterations 5 --loads 3 --palette-baseline-matrix --seed precomputed-index-matrix-20260926
node scripts/benchmark-palette.mjs --counts 100000 --recent-reads 20 --iterations 5 --loads 3 --palette-baseline-matrix --seed precomputed-index-memory-20260926
node scripts/benchmark-palette.mjs --counts 100000 --recent-reads 20 --iterations 5 --loads 3 --palette-index-matrix --seed precomputed-index-memory-20260926
node scripts/benchmark-palette.mjs --counts 5000,10000 --recent-reads 20 --iterations 5 --loads 3 --palette-score-matrix --seed balanced-midrange-score-20260926
node scripts/benchmark-palette.mjs --counts 5000,10000 --recent-reads 20 --iterations 5 --loads 3 --seed balanced-midrange-full-20260926
node scripts/benchmark-palette.mjs --counts 5000,10000 --recent-reads 20 --iterations 5 --loads 3 --palette-baseline-matrix --seed balanced-midrange-index-20260926
node scripts/benchmark-palette.mjs --counts 5000,10000 --recent-reads 20 --iterations 5 --loads 3 --palette-index-matrix --seed balanced-midrange-index-20260926
node scripts/benchmark-palette.mjs --counts 5000,10000 --recent-reads 20 --iterations 5 --loads 3 --palette-scope-matrix --seed balanced-midrange-scope-20260926
~~~

The `--palette-scope-matrix` mode and the per-scope (All/Recent/Pinned) measurements were removed on 2026-10-02 together with the palette's scope tabs (IMP-42); the commands above that use it are kept as a record of these runs and no longer execute. The score, index and baseline matrices now measure the single ranked list and record the blank palette's section titles.

The score matrix compares the current scorer with all 24 combinations of four contextual representations (`raw`, object `profile`, packed `CSR`, and runtime `inverted` affinity vector) and six signal representations (dynamic, `Float64Array`, `Float32Array`, split arrays, sparse recent/pin data plus a freshness array, and lazy freshness caching). The scope matrix varies full-index scanning, recent/pinned candidate prefiltering, and cached scope counts independently. The index matrix writes CSR word/folder features into the generated `SiteIndex` JSON and converts them to typed arrays when the palette opens. The final paired baseline run uses the same 100,000-record seed without that projection. Every mode opens a document so current-document affinity is exercised. Fixtures seed 20 reads and 20 pins and include controlled recent, pin, and freshness signals.

Each navigation types the empty query, `a`, `atlas`, fuzzy subsequence `pltfrm`, and `zzzz` in All, Recent, and Pinned. Five samples measure the first `a` key. The report records palette-open time, input JavaScript time, input-to-paint after two animation frames, score-profile setup, browser heap, typed-array storage, and exact top-eight IDs. Strategy order rotates between the three navigations. All 25 score configurations matched the current scorer in all three scopes and all five queries in all nine navigations: **zero ranking mismatches and zero page errors**. The separate index and scope matrices also had zero mismatches and errors. The Unicode score and ranking checks above remain green.

#### End-to-end scoring at 100,000 records

Values are medians across three browser navigations. Heap is JS heap after forced GC; typed-array storage is reported separately. The profile/scorer is constructed when the palette opens unless marked index-built.

| Scoring mode | Palette open | First `a` JS | First `a` input-to-paint | Setup on palette open | JS heap delta after palette | Typed-array storage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Current scorer | 391.8 ms | 290.9 ms | 300.3 ms | — | 19.02 MB | — |
| Object profile + Float32 signals | 325.9 ms | 60.7 ms | 69.8 ms | 188.9 ms | 30.56 MB | 0.40 MB |
| Runtime CSR + split signals | 332.3 ms | 59.8 ms | 69.0 ms | 193.2 ms | 19.00 MB | 3.57 MB |
| Runtime inverted vector + Float32 signals | 371.0 ms | 55.1 ms | 65.1 ms | 239.4 ms | 19.07 MB | 0.50 MB |
| Index-built CSR + dynamic signals | 158.7 ms | 72.5 ms | 81.4 ms | 0.6 ms | 13.84 MB delta* | 2.97 MB |
| Index-built CSR + Float32 signals | 162.7 ms | 59.9 ms | 68.8 ms | 13.8 ms | 13.90 MB delta* | 3.77 MB |
| Index-built CSR + split signals | 159.5 ms | 59.5 ms | 68.7 ms | 13.7 ms | 13.91 MB delta* | 3.57 MB |

`*` The index-built “heap delta” compares heap after opening the palette with heap after loading the projected JSON index, so it is not directly comparable to the no-projection rows. The paired absolute measurements below are the useful memory comparison.

The index-built profile reduces palette-open time from 378.4 ms to 158.7 ms and first-key input-to-paint from 297.1 ms to 81.4 ms. A Float32 signal vector reduces first-key JS time by a further 12 ms at a 0.40 MB cost; split signals are a similar choice. The 100,000-entry projection adds 4.59 MB of JSON (1.51 MB when gzip-compressed by Node) and took 148–185 ms to generate in these runs. The full projected index is about 59.7 MB raw / 6.71 MB gzip. On the same seed, page-ready p50 was 324.2 ms without the profile and 338.2 ms with it, a 14 ms increase in this local fixture.

| 100,000-entry memory state | No profile in index | Profile in index |
| --- | ---: | ---: |
| JS heap after page-ready, before palette | 78.73 MB | 83.89 MB |
| JS heap after palette and forced GC | 97.75 MB | 97.73 MB |
| Typed-array backing storage after palette | 0.67 MB | 3.64 MB |

The projection adds about 5.16 MB of parsed JS heap before the palette opens. On palette open it is converted to CSR typed arrays and replaces the JSON number arrays. After GC, JS heap is about the same as the unprojected run and the retained projection costs 2.97 MB of typed-array storage. These readings are retained-memory measurements; the brief peak while source arrays are being converted was not sampled.

The scorer setup timings show why static index features matter more to palette-open responsiveness than increasingly elaborate runtime indexes. Runtime CSR plus split signals reaches about 60 ms per first key but spends about 193 ms preparing profiles when the palette opens. Runtime inverted scoring is only about 5 ms faster per key and costs about 239 ms to prepare. The index-built profile moves the profile work out of palette open while preserving the same displayed ranking. The best measured balance is index-built CSR with dynamic or Float32 signals; Float32 buys a modest per-key reduction for about 0.40 MB.

#### Signal representation comparison

With the runtime inverted-context representation on the 100,000-record fixture, all six signal choices preserved exact top-eight ranking parity. The table shows the first-key JavaScript time, setup time, and total typed-array storage, including the 0.10 MB contextual score vector:

| Signals | First `a` JS | Setup | Typed-array storage | Heap delta after palette |
| --- | ---: | ---: | ---: | ---: |
| Dynamic | 62.9 ms | 225.2 ms | 0.10 MB | 19.05 MB |
| Float64 vector | 54.7 ms | 238.3 ms | 0.90 MB | 18.97 MB |
| Float32 vector | 55.1 ms | 239.4 ms | 0.50 MB | 19.07 MB |
| Split recency/pin/freshness arrays | 56.2 ms | 239.8 ms | 0.70 MB | 19.08 MB |
| Sparse reads/pins + freshness array | 57.1 ms | 242.0 ms | 0.20 MB | 19.04 MB |
| Lazy freshness cache | 59.0 ms | 226.5 ms | 0.10 MB | 21.13 MB |

Float32 retained the Float64 ranking in all tested scopes and queries at half the vector size. Lazy freshness caching used little typed storage but added about 2.1 MB of JS heap after all 100,000 candidates were visited. It is not a memory win for this workload. Recent-read recency and pin membership are user-specific and should be recomputed from the current history/pin state; they are not static index features. Freshness can be packed with them when the palette opens.

#### Recent and Pinned candidate filtering

Recent/Pinned currently match the query against the full index before discarding records outside the selected scope. The benchmark compares that flow with candidate filtering before fuzzy matching and with scope counts computed once per index/history state.

| 100,000-entry mode | Recent `a` JS | Recent `atlas` JS | Pinned `a` JS | Pinned `atlas` JS | Recent/Pinned input-to-paint p50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full scan + live counts | 52.6 ms | 51.1 ms | 53.8 ms | 50.0 ms | 54–63 ms |
| Full scan + cached counts | 45.0 ms | 42.6 ms | 44.9 ms | 42.3 ms | 43–47 ms |
| Prefilter + live counts | 10.8 ms | 10.4 ms | 10.6 ms | 11.0 ms | 27–33 ms |
| Prefilter + cached counts | 4.5 ms | 4.4 ms | 6.3 ms | 5.8 ms | 30–31 ms |

The combined option makes Recent and Pinned key handling about 8–12 times faster and brings input-to-paint down to the roughly 30 ms two-frame floor. All scope is unchanged by this option. At 20,000 records, the same choice reduces Recent/Pinned first-key JS from about 12–13 ms to 2–3 ms, though paint latency there was already near the two-frame floor. On a 20-site × 1,000-record setup, All was about 4.4 ms and Recent/Pinned about 2 ms per first key, so prefiltering had little practical effect.

#### Typical-size tradeoffs and the large-site tail

The 5,000- and 10,000-record trials fill the gap between the 1,000-record active site and the 20,000/100,000-record stress cases. They use the real palette, a document-open context, 20 recent reads and 20 pins, and the same empty/common/fuzzy/no-match queries and All/Recent/Pinned scopes. Each result is the median across three navigations; each navigation has five first-character samples. The reported p95 is the median of the per-navigation p95 values. The static-index comparison uses the same fixture seed for the unprojected baseline and projected index. All checked score/signal combinations and scope modes had **zero top-eight mismatches and zero page errors**.

| Active-site records | Profile cost in site index | Current palette: open / first-key JS p50 (p95) / input-to-paint p50 | Index-built CSR + split signals: open / first-key JS p50 (p95) / input-to-paint p50 | Retained-memory change after palette opens* |
| ---: | ---: | --- | --- | --- |
| 1,000 (20 sites) | +38.8 KB JSON / +14.9 KB gzip | 42.6 / 5.3 (5.6) / 30.3 ms | 43.3 / 2.0 (2.8) / 30.7 ms | Profile is about +38 KB raw in the active index; no meaningful palette-open or paint change |
| 5,000 | +201 KB JSON / +73.0 KB gzip | 57.7 / 14.8 (19.1) / 30.7 ms | 39.9 / 4.6 (6.4) / 30.9 ms | JS heap 10.70 → 10.68 MB; typed-array backing 0.668 → 0.841 MB |
| 10,000 | +408 KB JSON / +142 KB gzip | 70.5 / 28.9 (32.0) / 31.8 ms | 53.9 / 8.2 (9.5) / 30.7 ms | JS heap 15.71 → 15.76 MB; typed-array backing 0.668 → 1.014 MB |
| 20,000 | +827 KB JSON / +279 KB gzip | 115.7 / 55.8 (59.9) / 58.6 ms | 65.3 / 13.6 (15.7) / 31.3 ms | Profile comparison did not capture a paired retained-memory measurement |
| 100,000 | +4.59 MB JSON / +1.51 MB gzip | 378.4 / 288.5 (292.2) / 297.1 ms | 159.5 / 59.5 (63.9) / 68.7 ms | JS heap after GC is about unchanged; CSR adds 2.97 MB backing, plus about 0.60 MB for split signals |

`*` Memory readings are after forced GC. Unprojected/index-projected page-ready medians were 109.3/124.8 ms at 5,000, 122.7/122.9 ms at 10,000, 141.1/140.6 ms at 20,000, and 324.2/338.2 ms at 100,000. The local preview serves uncompressed JSON, while the gzip column is a compression-size estimate. With only three navigations, small readiness differences are noisy; the project does not yet have production traffic data to estimate the user distribution. The synthetic sizes therefore describe representative and tail scenarios, not a measured claim that a given percentage of users falls into each group.

At 1,000 records, the profile saves roughly 3 ms of JavaScript but does not improve palette-open or paint latency, so omitting it is reasonable when minimizing index bytes is the priority. At 5,000 and 10,000, CSR substantially lowers both palette-open time and first-key JS p95 for a modest 73–142 KB gzip addition. The input-to-paint measure remains near its roughly 30 ms two-frame floor, so the clear gain is lower main-thread work and better headroom rather than an equally large visible paint-time reduction. At 20,000, the profile also crosses that paint floor. At 100,000 it changes a multi-hundred-millisecond interaction into roughly 69 ms to paint, but that is still slower than a reliably fluid keypress; fuzzy matching the broad candidate set remains the tail bottleneck.

| Active-site records | Recent/Pinned mode | First `a` JS: Recent / Pinned | First `atlas` JS: Recent / Pinned | Input-to-paint |
| ---: | --- | ---: | ---: | ---: |
| 5,000 | Full scan + live counts | 4.7 / 4.8 ms | 3.6 / 3.4 ms | about 30 ms |
| 5,000 | Prefilter + memoized counts | 1.0 / 1.4 ms | 0.8 / 1.0 ms | about 30 ms |
| 10,000 | Full scan + live counts | 6.8 / 7.9 ms | 5.8 / 6.6 ms | about 30 ms |
| 10,000 | Prefilter + memoized counts | 1.3 / 1.6 ms | 1.1 / 1.2 ms | about 30 ms |

These are medians across three navigations. Candidate prefiltering does not affect All and preserves the same top-eight results. It adds no meaningful retained heap in these runs. For the common 1,000–10,000 range, dynamic recent-read, pin, and freshness scoring is the better signal tradeoff: replacing it with vectors saves only about 0.5–1.2 ms per first key at 5,000/10,000, while adding vector construction and retained storage. The signal layouts all preserved the same visible ranking. At 100,000, Float32/split vectors save about 12–13 ms per key for roughly 0.4–0.8 MB, which is a more defensible tail optimization. Lazy freshness caching retained about 2.1 MB more JS heap after all candidates had been visited, so it is not a memory win. Recent/Pinned prefiltering at 20,000/100,000 removes materially more work. Scope-count memoization changes little by itself compared with candidate prefiltering.

The middle-size full benchmark also ablated each ranking signal independently on four queries with matches (`empty`, `a`, `atlas`, and `pltfrm`). Recency changed the top eight on all four queries at both sizes. Pins changed the top eight on two queries at 5,000 and none at 10,000. Freshness was applied to two controlled records at both sizes, but did not change the visible top eight in this corpus. The combined signals changed the top eight on all four queries at both sizes. The no-match query changed no ranking. This confirms that recent reads are a useful relevance signal in these fixtures; pin and freshness boosts are correctly applied but their visible effect depends on candidate overlap and score margins.

The same full benchmark compared contextual data structures and the earlier candidate-search prototypes at 5,000/10,000. The measured memory is retained browser heap after building the benchmark-only structure; JSON gzip size is a local compression estimate.

| Representation | 5,000 records | 10,000 records |
| --- | --- | --- |
| Object word/folder profile | 12.2 ms build; 176 KB JSON / 50 KB gzip; +0.57 MB heap | 19.4 ms build; 353 KB JSON / 99 KB gzip; +1.13 MB heap |
| Packed CSR profile | 0.4 ms pack after profile; 143 KB typed arrays plus 46 KB context/signal vectors; about 193 KB combined | 0.6 ms pack after profile; 286 KB typed arrays plus 91 KB context/signal vectors; about 381 KB combined |
| Inverted context postings | 2.4 ms build; +251 KB JSON / 96 KB gzip; +0.45 MB heap | 4.1 ms build; +486 KB JSON / 206 KB gzip; +0.67 MB heap |
| Character postings for search | `atlas` 1.9 ms/character vs 1.3 ms cached scan; +2.58 MB heap | `atlas` 3.7 ms/character vs 2.5 ms cached scan; +4.92 MB heap |

The small-profile results favor CSR: it keeps the static feature and active scoring vectors under 0.4 MB total at these sizes. Inverted scoring is at most about 1 ms faster per key in the real palette but takes 2–4 ms more setup; the standalone postings experiment also retained more heap. Character postings leave 4,738/9,460 candidates after `atlas` and run slower than the existing incrementally narrowed scan. A sorted prefix dictionary is fast for `atlas` (0.2/0.3 ms per character), but returns 0 of 8 results for the valid fuzzy query `pltfrm`; it cannot replace the current matcher without changing search behavior.

The balanced direction supported by these fixtures is to consider index-built CSR from about 5,000 active records upward, keep recent/pin/freshness signals dynamic through the common range, and reserve precomputed signal vectors for very large sites where the per-key saving is material. Keep the 100,000-record case as a tolerated high-end scenario rather than the design target: it improves greatly, but still needs a fuzzy-matching optimization before it can be called fluid. This is a workload-based engineering choice, not a claim about the actual 99th percentile of users; the repository has no real site-size distribution to establish that percentile.

#### Conclusion

The score representations, signal layouts, index-built CSR profile, and Recent/Pinned candidate filtering have been measured in the real palette across active indexes from 1,000 to 100,000 records, including 20 sites × 1,000 records. CSR has a useful middle ground: at 5,000–20,000 it reduces palette-open and key-processing time for a modest index-size increase; the tiny 1,000-record site sees little user-visible benefit, while the 100,000-record case improves sharply but remains slower than fluid typing. Dynamic signals are the better memory/setup balance at ordinary sizes; Float32/split vectors are worth considering only where large-site per-key cost justifies their extra storage. Recent/Pinned prefiltering is most valuable on large sites and does not change All. Every contextual scorer, signal layout, CSR profile, and scope-filter strategy preserved the current visible ranking, including fuzzy subsequence matches and the Unicode parity corpus. The separate sorted-prefix search prototype was rejected because it loses fuzzy matches. The selected CSR, signal, and scope-filter policies are now in the product; unselected scorer and search prototypes remain benchmark-only. Local measurements do not predict public-network latency.

#### Selected production path (2026-09-26)

The indexer now emits an optional version-1 CSR palette profile for sites with at least 5,000 artifacts. It stores shared-word and shared-folder IDs with 16-bit values when the vocabulary fits, and 32-bit values otherwise. The browser validates the profile, converts its JSON number arrays to typed arrays on first palette use, and makes the number arrays eligible for garbage collection. Older indexes and invalid profiles continue through the runtime scorer. The brief peak while both representations overlap has not been measured.

Recent and Pinned now prefilter candidates before fuzzy matching, and their counts are memoized per index/history state. All still searches the full site index. Recent-read, pin, and freshness boosts remain dynamic below 100,000 artifacts; at 100,000 and above, the palette uses a 6-byte-per-artifact split signal vector (Float32 recency plus byte pin and freshness values). This keeps vector construction and storage out of the tested typical range while applying the measured per-key savings to the large-site tail.

The build and E2E suite pass, including a 5,000-artifact browser test with the serialized profile. The 100,000-artifact latency and memory figures above come from the benchmark matrix, which tests the same CSR and split-signal representation. Real production site-size and network distributions remain unknown.
