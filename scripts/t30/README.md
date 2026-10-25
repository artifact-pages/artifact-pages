# T30 probes

Measurement tooling for [T30](../../docs/backlog/verification/T30-cache-freshness-and-root-latency.md). It uses public URLs only: no credentials, no secrets, no cache-busting query strings. Needs Node 20+; the reader probe also needs `npm ci` and `npx playwright install chromium`.

## Scripts

```sh
node scripts/t30/probe-roots.mjs  --base https://artifact-pages.stream --label ttl5-jp --samples 50 --out roots.jsonl --sites smoke,verify-scale-1000
node scripts/t30/probe-reader.mjs --base https://artifact-pages.stream --label ttl5-jp --samples 20 --out reader.jsonl
node scripts/t30/summarize.mjs --json summary.json --md summary.md roots.jsonl reader.jsonl
```

`summarize.mjs` prints the markdown table to stdout when `--md` is omitted.

### probe-roots

Requests `/_indexes/sites.json`, `/_indexes/<site>/meta.json`, `/_indexes/<site>/index.json` and the control `/_indexes/<site>/search/manifest.json` (always `s-maxage=0`), each over a new TLS connection (`keepAlive: false`). Each sample records three kinds per URL:

- `prime`: the first request, issued after the URL has been idle for at least 6 s, so the previous edge entry has expired.
- `fresh`: issued immediately after the prime (well under 1 s). Under `s-maxage=5` this should be an edge HIT.
- `expired`: issued after the URL has been idle for 6 s following the fresh request.

URLs are interleaved so the idle waits overlap (about 10 s per sample, so 50 samples take about 9 minutes). `--expire-wait-ms` changes the 6 s idle time.

Each JSONL line: label, ISO timestamp, sample, kind, class, site, url, DNS / connect / TLS / TTFB / total ms, status, wire bytes, content-encoding, `age`, `cf-cache-status`, `etag`, `last-modified`, `cache-control`, `cf-ray` and its colo (last 3 letters).

### probe-reader

Drives the real SPA in Chromium, one fresh browser context per sample (cold HTTP cache), with the cache enabled and normal URLs. Steps, each timed until its content is visible:

- `a_cold_open`: navigation to `/verify-scale-1000` until the document list shows.
- `b1_open_doc`, `b2_back_home`, `b3_open_doc2`: three-page SPA session (open a document, go back to the home, open a second document).
- `c_reload`: normal reload of the site home in the same context (browser cache applies).
- `d_search`: open search, type `searchable` (a word in the fixture pages), submit, until the result count line shows ("N pages contain ...").

Each line also lists the root JSON responses seen during the step (sites, meta, index, search manifest): status, `cf-cache-status`, `age`, `etag`, `cache-control`.

### summarize

Per label x URL class x kind (roots) and per label x step (reader): count, errors, mean, p50, p95 and sample standard deviation (p95 is nearest-rank). Roots report TTFB and total; the cf-cache-status distribution is included for both.

## Running in Actions

`.github/workflows/t30-probe.yml` runs on `workflow_dispatch` (inputs `label`, `samples_roots`, `samples_reader`). The label gets a `-na` suffix (GitHub-hosted runners are in North America, but the region and edge colo can differ between runs: record the colo and compare only runs from the same one). It uploads the JSONL and summary files as artifact `t30-<label>-na` and appends the summary to the job summary. Japan and Europe runs are done locally or from other vantage points.

## Caveats

- Timing is browser-to-edge (client to Cloudflare) only. Edge-to-origin work shows up only as added latency.
- An origin 304 is not observable: `cf-cache-status: REVALIDATED` means the edge revalidated, but the client gets a 200 either way, so edge-to-R2 304 behavior stays UNVERIFIED.
- These are artificial bursts with a controlled schedule, not natural traffic. Do not derive natural hit rates from them (see T30 plan step 2).
- Hits and misses depend on the edge colo and the runner's network path; compare labels measured from the same vantage point.
- The reader probe reports the root responses the page received; a browser-cache revalidation can hide an edge hit or miss behind a 304.
