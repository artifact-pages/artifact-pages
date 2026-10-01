# Full-text search with an actual local projection

Date: 2026-10-01. Follow [the local load procedure](../guides/local-fulltext-load.md) to reproduce.

## Verified deployment

Generated **61,000 actual pages**: sites with 1,000, 10,000, and 50,000 documents, totaling 54,900 HTML and 6,100 Markdown files. The existing Go CLI built each site's navigation index; the research extractor and packed index produced its full-text data. The real SPA and both projections were served by nginx 1.29 under the isolated `gap-fulltext-load` Compose project, bound to port 4188. The regular local container continued to run on port 4179.

Run: `.local/fulltext-load/run-20261001101659717-648ba6c0/`. Seed: `27326139`. Headless Chromium `153.0.8010.12`. The same projection was benchmarked again after adding control checks; the following figures are from its final `results.json`.

## Generated size and build time

| Pages | HTML/Markdown bytes | Navigation index raw / gzip estimate | Full-text stored bytes | Root bytes | Metadata build | Text extraction | Search build + packaging |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1.98 MB | 0.90 MB / 22.1 KB | 154.8 KB | 21.5 KB | 0.53 s | 0.12 s | 0.11 s |
| 10,000 | 19.77 MB | 10.05 MB / 285.0 KB | 1.15 MB | 79.5 KB | 0.46 s | 0.67 s | 0.74 s |
| 50,000 | 98.83 MB | 50.43 MB / 1.40 MB | 5.59 MB | 326.1 KB | 2.28 s | 3.17 s | 7.20 s |

Units are decimal. Page bytes exclude the two tiny shared CSS/JS resources per site. The search storage number includes root, document-path table, and all 128 leaf objects (129 files total). Navigation JSON is actually stored uncompressed; its gzip column is a level-9 estimate, while this nginx profile uses level-6 HTTP JSON gzip. Metadata build includes process overhead, and extraction includes `go run` startup. The CLI was compiled once beforehand. Separate metadata/extraction passes are research scaffolding; a future integrated builder could reuse parsed documents.

The non-monotonic small metadata timing is startup/cache noise. Generated pages are untracked under ignored `.local/`, so these runs do not measure a large tracked Git-history corpus. The generated text is a controlled mixture of a shared vocabulary and Japanese paragraphs, not production search traffic.

## Search results

Each row pools four cold queries across three fresh contexts, followed by the same warm query in each context. All 72 cold and 72 warm result arrays matched the oracle derived from actual page bytes. Search-data/decoder requests before submit were zero; every warm repeat made zero requests.

| Pages | Profile | Cold input-to-paint p50 / p95 | Cold search payload | Retained heap delta |
| ---: | --- | ---: | ---: | ---: |
| 1,000 | Local | 40.5 / 54.4 ms | 25.1–26.1 KB | 0.77–0.79 MB |
| 1,000 | Constrained | 299.4 / 388.8 ms | 25.1–26.1 KB | 0.76–0.79 MB |
| 10,000 | Local | 41.9 / 59.4 ms | 83.0–91.4 KB | 1.74–1.77 MB |
| 10,000 | Constrained | 537.9 / 657.3 ms | 83.0–91.4 KB | 1.73–1.77 MB |
| 50,000 | Local | 112.3 / 139.9 ms | 329.6–370.8 KB | 6.15–6.20 MB |
| 50,000 | Constrained | 1,485.1 / 1,771.4 ms | 329.6–370.8 KB | 6.15–6.20 MB |

Constrained means 80 ms added latency, 2.5 Mbps download, 1 Mbps upload, and CPU slowed 4× through Chromium. This is not a real mobile device. The paint measure waits for two animation frames after rendering, and is a consistent responsiveness proxy rather than a hardware paint timestamp. With 12 samples in each row, nearest-rank p95 equals the observed maximum. Bytes are encoded response bodies including the lazy decoder; lab shell and reader navigation are excluded. `transferSize` in raw results is the browser's header-inclusive estimate. Heap delta is after GC, not peak allocation.

Warm p50 was 8.6–27.2 ms across the six scenarios. Do not treat small differences near the animation-frame floor as a ranking between profiles.

On the 50,000-page site, one cold `cache` search painted in 89.5 ms. Eight concurrent cold browser clients painted in 131.8–224.1 ms; the complete wave, including context/page setup, finished in 517.3 ms. This is one shared-host wave and does not establish nginx throughput capacity or production RPS limits.

## Functional evidence

- Real result links use `/:site/<encoded-path>` and open the actual HTML in an iframe.
- Relative CSS and JavaScript loaded, and reload preserved the rendered document.
- A filename containing space, `#`, `?`, `%`, `+`, and Japanese loaded through its encoded logical route.
- A Markdown result opened in the native reader.
- `body-only-000007` found its page even though that identifier is absent from title/path metadata.
- Hidden markup and a runtime-only JS-generated marker had no search matches.
- A simulated root-fetch HTTP 503 produced an error, and a later submit recovered after the failure was removed.
- Sequential submissions displayed the final committed query correctly.
- The screenshot and complete samples remain in the run directory. The browser UI is a research form, not a production palette replacement.

## What this changed in the assessment

Actual navigation introduced a cost missing from the earlier microbenchmark: **the result-to-path mapping must exist somewhere**. This prototype puts all document paths in the root so a search can link to a page without loading the full navigation index. That mapping, plus growing singleton vocabulary, increases the 50,000-page cold root to 326 KB. Even an absent query must retrieve it once. At 2.5 Mbps, its transfer alone is about 1.04 s before request latency/decode/rendering.

The next useful experiment is to separate the path table and resolve only displayed results, then measure both the saved root bytes and added lookup requests. Other candidates are a front-coded binary path table, a second-level dictionary, and site-specific partition counts. The current form displays only 20 links but computes the complete matching set; no matches were silently truncated to achieve these figures.

The shared vocabulary makes these cold queries touch few leaves. A broader substring may touch many leaves, as shown in the [cost investigation](fulltext-search-cost.md). Do not generalize the 25–371 KB range to all queries. Capacity improvements should be evaluated against a wider query corpus and longer Japanese prose before adopting a production format.

The local projection and reproducible verification procedure now exist. Search ranking, snippets, automatic format selection, generation retention, and provider publishing remain separate work; no public deployment or production index-schema change was made.
