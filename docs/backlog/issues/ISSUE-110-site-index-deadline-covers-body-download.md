# The site index deadline covers the body download, so a large index on a slow link fails every time

- Status: Done
- Priority: P2
- Assignee: Claude
- Area: Web / site-index loading
- Source: T25 extended local measurements 2026-10-17, build `c7d5d2b9`
- Related: [ISSUE-101](ISSUE-101-registry-and-site-index-loads-have-no-deadline.md) (introduced the deadline), [ISSUE-102](ISSUE-102-load-errors-offer-no-retry-action.md) (Try again), [T25](../verification/T25-web-first-load-and-search-at-scale.md)

## Problem

`SITE_INDEX_TIMEOUT_MS` (20 s, `web/src/data/indexes.ts`) bounds the whole site-index read, response headers and body. When the body cannot be downloaded within 20 s, the reader shows "Unable to load this site / This site is taking too long to load. Try again in a moment." and "Try again" starts the same request, which hits the same limit. On a slow link a large index therefore never loads, however many times the reader retries, even though bytes are arriving the whole time.

Whether this reaches users depends on delivery. Local nginx serves `index.json` uncompressed; Cloudflare serves it brotli-encoded. The 50,000-page index is 45.90 MB raw and 2.63 MB gzip (level 9). At 1.6 Mbps the uncompressed 5,000-page index (4.39 MB) needs about 22 s and the compressed 50,000-page index about 13 s (arithmetic: size x 8 / bandwidth, ignoring latency). The compressed 50,000-page index would exceed 20 s below roughly 1 Mbps. These two arithmetic figures are estimates, not measurements.

## Evidence and reproduction

Measured (T25 extended local phase, [report](../../research/web-scale-benchmark.md#first-mermaid-render)):

1. Serve the benchmark sites with the repository's nginx setup (`npm run benchmark:web-scale`, `--only mermaid --profiles constrained --keep`, sites of 5,000, 10,000 and 50,000 pages). The constrained profile is CPU x4, 150 ms RTT, 1.6 Mbps down.
2. Open `/<site>/overview-0.md` from a fresh browser context (cold) and again in the same context (warm).
3. Result, in all 3 iterations at each of the three sizes: the reader showed "Unable to load this site" about 24.6 s after navigation cold (the 20 s deadline plus about 4.6 s before the index request starts, while the app loads) and 20.2 s warm. The aborted request was `/_indexes/<site>/index.json` every time.
4. At 1,000 pages (index 0.78 MB) the same visit rendered the diagram in 13.8 s cold, so the failure starts where the index no longer fits in the deadline at this bandwidth.

Source (confirmed by reading, not by a separate run): `fetchSiteIndex` starts the timer before `fetcher(url)` and clears it in `finally`, after `response.json()` has read the body, so the deadline spans the download. By the source, "Try again" starts a new request with a new 20 s budget and no memory of progress; the harness did not click it.

Not measured: Cloudflare under the constrained profile for the Mermaid page (the earlier Cloudflare constrained phase opened a 50,000-page site in 15.4 s through the site route, which is below the deadline).

## Options for the owner

These are alternatives; none is chosen here.

1. Deadline only until the first response byte, or on stalled progress (no body bytes for a set time) instead of total time. A slow but moving download completes; a dead connection still fails.
2. A deadline scaled to the declared size (the discovery metadata or `Content-Length` gives the size). Needs the size to be known before the read and a rule for the scale factor.
3. Keep the total deadline as is and document the minimum bandwidth it implies, relying on compressed delivery in production.

## Expected outcome

A large index on a slow but working connection either loads or shows an explanation that a retry can act on; a retry must not repeat a failure that is certain to recur.

## Acceptance criteria

- [x] The owner chooses an option (or keeps the current behaviour with documentation): option 3, see Decision.
- [ ] Not applicable under option 3 (no behaviour change): with the constrained profile (1.6 Mbps) and the 5,000-page uncompressed local index, the first Mermaid render and a site open either succeed or show the documented outcome, in a repeatable test.
- [ ] Not applicable under option 3 (no behaviour change): a stalled connection (no bytes) still fails within a bounded time and "Try again" recovers once the connection works.
- [ ] Not applicable under option 3 (nothing changes to re-measure): the T25 report records the re-measurement.

## Decision

Owner, 2026-10-18: option 3. The total 20 s deadline stays as it is. The implied minimum throughput and the reliance on compressed delivery are documented as a constraint in the [specification](../../specification.md#8-browser-ux) ("Site index load deadline"). No code change.

On AWS, CloudFront compresses only objects between 1,000 and 10,000,000 bytes and the CLI stores `index.json` uncompressed, so a site index above 10 MB is delivered uncompressed.
