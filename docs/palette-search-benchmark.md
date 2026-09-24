# Site-local palette search benchmark

Date: 2026-09-25

This benchmark measures the current browser product's site-local artifact search. Typing is simulated one character per input event (`atlas`), with a paint opportunity between keystrokes. Fixtures are deterministic, synthetic, and generated under ignored `.local/`; timings are from local headless Chromium and are not a prediction of CDN or public-network latency.

## Reproduce

```sh
npm run build
node scripts/benchmark-palette.mjs --counts 20000 --chunk-sizes 250,1000,5000 --iterations 5 --loads 3 --seed sequential-chunk-trial-20260925
node scripts/benchmark-palette.mjs --counts 1000 --sites 20 --artifacts-per-site 1000 --iterations 12 --seed sequential-multisite-20260925
```

`--chunk-sizes` enables a benchmark-only fetch adapter: it eagerly downloads every artifact chunk and reassembles the same complete `SiteIndex` before rendering. It does not change the product index contract.

## Results

| Scenario | Current-site index bytes | Detail requests | Ready-to-use p50 | Detail JSON parse p50 | Aggregate body-read p50 | Heap after search p50 | Search JS by typed character (p50) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 site × 20,000, monolithic | 9.85 MB | 1 | 606 ms | 7.0 ms | 27 ms | 80.48 MB | `a` 9.6, `t` 9.4, `l` 6.6, `a` 2.7, `s` 1.4 ms |
| Eager chunks of 250 | 9.85 MB (+3.8 KB manifests) | 81 | 607 ms | 7.7 ms | 180 ms | 81.05 MB | `a` 9.7, `t` 9.3, `l` 6.3, `a` 2.6, `s` 1.4 ms |
| Eager chunks of 1,000 | 9.85 MB (+0.9 KB manifests) | 21 | 606 ms | 7.5 ms | 138 ms | 81.02 MB | `a` 9.5, `t` 9.0, `l` 6.4, `a` 2.6, `s` 1.4 ms |
| Eager chunks of 5,000 | 9.85 MB (+0.2 KB manifests) | 5 | 621 ms | 6.6 ms | 62 ms | 80.49 MB | `a` 9.7, `t` 9.6, `l` 6.6, `a` 2.6, `s` 1.3 ms |
| 20 sites × 1,000, current site active | 486 KB active index; 3.7 KB all metadata | 1 index + 20 metadata | 141 ms | 0.7 ms | — | 8.60 MB | `a` 2.1, `t` 1.8, `l` 1.1, `a` 1.0, `s` 0.8 ms |

Values for chunk variants are medians across three full navigations with the same deterministic 20,000-artifact seed. The memory column is Chromium JS heap after search and forced garbage collection. `Aggregate body-read` sums response-body read durations; with concurrent chunks, these overlap and are not elapsed wall time. Input-to-paint uses a double-`requestAnimationFrame` probe (about 31–35 ms here), so treat it as a consistent UI responsiveness proxy, not a hardware paint timestamp.

For the same 20,000-artifact seed and payload, the prior palette search implementation measured about 94.39 MB after search and 66.4 ms for the cold first key. The new implementation measured about 80.48 MB and 30.7 ms: approximately 13.9 MB (14.7%) less retained heap and 54% less cold-key JS time. In later keystrokes, the candidate set narrows monotonically while the user extends a query; the last two characters fell to about 1–3 ms. Backspace or a non-prefix edit falls back to a complete current-site scan.

The search-only cache now keeps compact normalized strings rather than per-word object graphs. It computes scores without constructing match-position arrays for every artifact, and generates highlighted positions only for the eight displayed results.

## Chunking decision

Eagerly fetching all chunks did not reduce bytes, steady-state heap, or sequential-search time because the app still needs every current-site artifact to provide complete search and browsing. Ready-to-use time stayed within run-to-run noise (606 ms monolithic; 607/606/621 ms for 250/1,000/5,000 chunks), while request count rose from 1 to 81/21/5. At 250 and 1,000 records per chunk, aggregate body-read time rose substantially; the 5,000-record variant came closest to the monolith but still showed no user-visible benefit. Do not add eager index sharding to the product contract yet.

If real sites materially exceed this envelope, the next experiment should reduce the data retained by the browser (for example, a compact navigation/search projection with non-search details loaded only when needed), then measure its impact on direct artifact navigation and Details/Contents. A shard or inverted index should follow only if that experiment still leaves a user-visible bottleneck.
