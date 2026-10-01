# Local full-text load verification

This is a local research deployment for [the capacity-focused search design](../research/fulltext-search-cost.md). It creates actual HTML/Markdown pages and uses the current Go index builder and the built SPA, plus an experimental submit-to-search page. It does not change the production search UI or index schema.

## Generate, serve, measure

From the repository root, with Go, npm dependencies, Playwright Chromium, and Docker Compose available:

```sh
# Generate 61,000 pages across three sites and both index projections.
npm run fulltext:load -- generate --counts 1000,10000,50000 --shards 128

# Build the SPA and serve the projection through a separate nginx container.
npm run fulltext:load -- serve

# Reuse the generated projection; run cold/warm, constrained, and concurrent checks.
npm run fulltext:load -- benchmark --iterations 3 --concurrency 8
```

Open [the search lab](http://127.0.0.1:4188/search-lab.html). Select a site and submit `cache`, `再試行`, or `body-only-000007`. The last term exists only in the document body. Search results link to normal `/:site/<path>` routes in the SPA. The root site's regular [site selection](http://127.0.0.1:4188/) is also available.

`benchmark` runs `serve` as part of the command. On first use it also generates the default three sites. If a projection already exists, it reuses it; passing a different explicit count/shard/seed or `--regenerate` creates a new run directory. For example, a small smoke run:

```sh
npm run fulltext:load -- benchmark --counts 100 --iterations 1 --concurrency 2
```

For another port, pass `--port 4190` to `serve` or `benchmark`. To change the seed, pass an integer `--seed`. Counts must be unique positive page counts of at least 10; tested scales are 1,000, 10,000, and 50,000. Each site currently uses one fixed shard count so the first experiment is reproducible; this is not an automatically tuned production policy.

The deployment binds to loopback and uses Compose project `gap-fulltext-load`. It uses the existing base Compose and routing rules with an experiment-only compression override. An existing default Compose project remains on its existing port. The benchmark leaves the lab running for inspection.

## What is generated

Generated data remains under ignored `.local/fulltext-load/run-<time>-<id>/`:

```text
storage/_artifacts/load-*/       actual ready-to-serve pages and local CSS/JS
storage/_indexes/sites.json     discovery catalog
storage/_indexes/load-*/        production builder's index.json and meta.json
storage/_indexes/load-*/search/ experimental compressed root and content-hashed leaves
web/                            built SPA, research form, client, lazy decoder
oracle.json                     expected results derived from extracted actual page bytes
build.json                      generation/build/size measurements and corpus hashes
results.json                    individual browser/network/memory samples
summary.md                      readable aggregate results after benchmark
search-lab.png                  screenshot after functional checks
web-build.log                   SPA build output
```

`.local/fulltext-load/current.json` identifies the active run and port. Partial generation does not replace this pointer. Artifacts are generated directly in the local storage tree; metadata is built in a separate staging directory and moved into the serving tree because the builder excludes its output tree from source discovery.

Pages mix 90% HTML and 10% Markdown. Bodies use a deterministic word vocabulary sampled from committed artifact fixtures, Japanese sentences, rare terms, and one body-only identifier per document. The first HTML page includes spaces, Japanese, and reserved URL characters in its filename. HTML pages load relative CSS and JavaScript. Hidden text and JS-generated text have markers that must not become searchable.

The normal navigation index is built by the real CLI, not synthesized from the expected answer list. Full-text records come from parsing those actual files and are reordered to the builder's artifact order. The experimental root includes a document-path table so result links do not depend on a previously loaded full navigation index. Its bytes are included in the benchmark.

## Measurements and checks

- Four queries × three fresh browser contexts for each scale and each profile; fresh contexts include a cold decoder import.
- No search payload or decoder request until Enter; repeated searches reuse memory cache with zero requests.
- Exact result-array comparison with `oracle.json`, including body-only and no-match queries.
- Encoded response-body bytes, Resource Timing transfer-size estimates, request count, compute time, and two-frame input-to-paint proxy.
- Retained JS heap after forced GC relative to the pre-search page. `observedHeapMax` samples absolute heap every 20 ms, and may miss short-lived peaks.
- Local profile and a constrained profile with 80 ms additional latency, 2.5 Mbps down, 1 Mbps up, and CPU slowed 4×.
- One and eight simultaneous cold browser clients on the largest site, as a single wave.
- Result selection, HTML iframe, relative stylesheet/script, reload, reserved filename, and Markdown reader.
- Simulated HTTP 503 and retry, hidden/runtime-only text exclusion, and final state after sequential query submissions.

Search bytes include lazy decoder + root + relevant leaves. The initially loaded lab shell/client and subsequent navigation into the real reader are separate costs. `.gz` search payloads are application-decoded once; the decoder's precompressed `.js.gz` is served with normal HTTP gzip encoding. The experiment enables JSON/text gzip without changing the repository's regular nginx configuration.

These are synthetic content and one-host browser measurements. CPU/network emulation is not a real phone or CDN. With 12 pooled cold samples per scale/profile, nearest-rank p95 is the maximum observation, not a reliable production-tail estimate. The concurrent wave does not establish a server RPS limit or long-running stability. There is no numeric product performance SLA yet.

## Stop and preserve evidence

```sh
npm run fulltext:load -- stop
```

This removes only the lab's Compose container/network. Generated files remain for review. New generation creates a separate directory, so old successful results remain available. A repeated benchmark of the same run replaces that run's `results.json` and `summary.md`; copy those files first if comparing multiple trials.

To rebuild a summary from existing raw results without redeploying:

```sh
node scripts/fulltext-load-summary.mjs .local/fulltext-load/run-<time>-<id>/results.json
```

The [recorded local benchmark](../research/fulltext-local-load-benchmark.md) provides the first verified run and the next measured bottleneck.
