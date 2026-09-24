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

Do not ship either projection or add network shards based on these results. The remaining measurable bottleneck is early input on a single very large site, not the number of sites when only the active site index is loaded. Next, test a fuzzy-preserving candidate structure (for example, ordered subsequence-pair postings or a compact precomputed top-eight projection for one-character queries) against the exact current result set. Include projection build cost, compressed bytes, request count/latency, browser heap, input-to-paint, and backspace/non-prefix edits before deciding whether it is worth the complexity. Keep chunking, which only changes transport, separate from candidate pruning, which changes the amount of search work.
