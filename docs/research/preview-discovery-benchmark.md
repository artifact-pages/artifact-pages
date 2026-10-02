# Preview discovery benchmark

This records Phase 1 browser-side discovery measurements for T7. The synthetic catalog sizes are exploratory probes, not a product capacity claim. The specification and roadmap define no preview-list latency, memory, payload, site-count, or group-count target.

## Run

```sh
npm run benchmark:preview-discovery -- --sites 20 --groups 100,500,1000 --runs 3 --input-samples 5 --seed t7-20260927
```

Since 2026-10-02 (IMP-42) the palette no longer lists preview documents and the `--input-samples` option is gone; the second surface is now `palette-open-previews-command` (open the palette, check it fetches no preview data, run "Open previews" and time the list paint). The palette results below were measured with the former Previews tab and remain as a record.

The runner builds the SPA, launches Chromium against Vite preview, and fulfills generated `/_indexes/*` and `/_previews/*` responses in Playwright. Each run uses a new browser context. The first scenario replays the committed SRE preview catalog and manifests; the other scenarios use deterministic synthetic catalogs with 100, 500, and 1,000 unique revision heads in one selected site and 19 other sites.

The synthetic manifest mix is 80% HTTP 200, 10% confirmed 404, and 10% HTTP 503. Missing entries are hidden; read errors remain visible as unknown. Each surface is repeated three times. The palette input-to-paint measurement uses five samples per run. P50/P95 below summarize those runs; with three independent runs, the run-level P95 is the maximum observation.

Environment: Node v22.14.0, macOS arm64, Chromium 153.0.8010.12, 1280×900 viewport. Raw JSONL: `.local/preview-discovery-benchmark/20260927115718676-6353f4f3-seed-t7-20260927.jsonl` (ignored by Git).

## Results

Response byte counts are uncompressed UTF-8 response-body bytes for the selected site's catalog and manifest responses, including short 404/503 bodies. They exclude HTTP headers and compression. JSON parse is measured around the browser's `Response.json()` path; CDP heap deltas are collected after forcing GC from the site-home state to the preview surface.

| Scenario | Selected-site payload | Manifest checks | Statuses (200 / 404 / 503) | Availability envelope p95: list / palette | List click-to-render p50 / p95 | Palette tab-to-render p50 / p95 | Palette typing-to-paint p50 / p95 | Catalog parse p95 | Manifest parse total p95 | Heap delta p95: list / palette |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Committed SRE fixture (4 groups, 2 unique heads) | 4.5 KB | 2 | 1 / 1 / 0 | 5.2 / 2.1 ms | 94.6 / 103.9 ms | 320.6 / 321.1 ms | 29.9 / 31.0 ms | 0.1 ms | 0.1 ms | 0.66 / 1.34 MiB |
| 20 sites × 100 active-site groups | 80.4 KB | 100 | 80 / 10 / 10 | 34.0 / 37.1 ms | 130.8 / 132.1 ms | 351.2 / 353.3 ms | 30.8 / 31.8 ms | 0.2 ms | 0.2 ms | 1.07 / 3.13 MiB |
| 20 sites × 500 active-site groups | 402.5 KB | 500 | 400 / 50 / 50 | 124.2 / 125.0 ms | 216.9 / 247.4 ms | 450.6 / 451.5 ms | 30.3 / 42.5 ms | 0.5 ms | 0.7 ms | 2.33 / 10.43 MiB |
| 20 sites × 1,000 active-site groups | 805.2 KB | 1,000 | 800 / 100 / 100 | 224.6 / 249.7 ms | 379.7 / 382.3 ms | 566.6 / 569.7 ms | 56.5 / 68.0 ms | 0.9 ms | 0.9 ms | 3.86 / 19.48 MiB |

The active-site catalog was the only preview catalog requested in every run. The browser requested one manifest per distinct active-site head; no other site's catalog or manifest was requested. At 1,000 groups, the measured availability-request envelope was 224.6 ms p95 on the list and 249.7 ms p95 on the palette. No page errors occurred.

## Decision and limits

No numeric product performance budget is defined, so these results do not establish an SLA or prove public-network performance. Within this synthetic browser-local envelope, first usable list and palette results stayed below 600 ms at 1,000 groups, typing-to-paint stayed below 70 ms p95, and the measured palette heap delta was about 19.5 MiB. This does not show a local browser bottleneck that would justify sharding or a changed discovery projection. Keep the active-site-only catalog rule and current projection; do not add an application-managed expiry clock.

Playwright fulfills API responses in-process, so these are response-body sizes and browser processing/request-scope measurements, not nginx, object-store, CDN, compressed-wire, or public-network timings. The local edge/object-storage profiles in [IMP-36](../backlog/implementation/IMP-36-local-edge-object-storage.md) can provide a more realistic local HTTP path; rerun this characterization there if that path changes catalog delivery or exposes a real bottleneck. Real AWS/Cloudflare delivery remains a separate verification boundary.
