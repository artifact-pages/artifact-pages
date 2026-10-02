# Static full-text search core

Implemented in [IMP-41](../backlog/implementation/IMP-41-fulltext-search-core.md). The production palette still uses its existing metadata search. This core can be called from a later submit-to-search interface without choosing that interface now.

## Build and publish

```sh
go run ./cli/cmd/artifact-pages index build \
  --site sre --source docs/artifacts --out .local/storage --fulltext

# The existing registered-site publisher builds and reconciles the same data.
go run ./cli/cmd/artifact-pages site publish --site sre --fulltext
```

`--fulltext` defaults to false. Pass it on every publication that should retain full-text search. Publishing without it withdraws `meta.json.fullTextUrl` and removes that site's search objects. An ordinary metadata-only build remains supported. This is an option on existing operations, not a separate search service or a requirement to install Node for the Go publisher. Deployment config and Actions do not yet expose a persistent enablement setting.

Enabled discovery metadata includes:

```json
{ "fullTextUrl": "/_indexes/sre/search/manifest.json" }
```

The full artifact index is unchanged. Search can run without downloading it or retrieving original page bodies. It returns paths/IDs; display titles and other reader metadata can come from the active site's existing index.

## Calling the browser API

```ts
import { createSiteFullTextSearch } from './data/fulltext'

const search = createSiteFullTextSearch(siteMetadata) // no request

// Call on query commit (Enter/button), not on each keystroke.
const controller = new AbortController()
const result = await search.search('再試行 cache', {
  signal: controller.signal,
  offset: 0,
  limit: 20,
})

// result: { siteId, query, generation, total, hits, hasMore }
// hit: { id, path, href }, e.g. /sre/reports/latency.html
// Another page: await search.search(query, { offset: 20, limit: 20 })

search.clear() // release the site's retained generation/leaf cache
```

Construct one client for the current site metadata and clear/drop it when leaving the site. Its `available` property reflects whether metadata advertises full-text search. An unavailable client's search rejects with `FullTextSearchError.code === 'unavailable'`; it does not silently fall back to a different search mode. Fetch failures use `network` (with HTTP `status` when known), including a failure to load the lazily imported decoder chunk; invalid manifests, checksums or payloads use `invalid-data`. An aborted caller rejects with its signal's reason. Empty input yields no hits without loading the decoder or search data. Query length is bounded to 4,096 UTF-16 code units; offset must be a nonnegative safe integer, and limit is 1–1,000 (default 20); a query or page outside these bounds rejects with a `RangeError` before any fetch.

The decoder is dynamically imported on the first nonblank search. The API caches one manifest/root and required decoded leaves. Warm queries reuse those promises; failed promises are evicted. Manifest freshness is 60 seconds; subsequent searches revalidate after that time. Hashed blobs use normal HTTP cache behavior. `clear()` forces the next query to load a fresh manifest. Up to six leaf requests are in flight per search. Multiple simultaneous searches share cached requests; cancelling one caller stops its wait and further scheduling, while already shared requests can complete for another caller. `clear()` drops cache ownership without aborting another in-flight search.

The API does not drive a UI or suppress earlier query responses. The eventual UI must use a submission ID or cancel its previous caller so an older response cannot overwrite a newer query. Debouncing, IME behavior, keyboard navigation, loading indicators, error copy, result titles and ranking are separate UX work.

## Search semantics

Both languages use NFKC normalization, Unicode lowercase and ECMAScript whitespace folding. The normalized text is split on spaces at build time; each distinct token contributes a document posting once. A committed query is split on the same whitespace. Every query term must occur as a substring of some token in the document; term order is irrelevant. This supports unspaced Japanese substrings without storing every bigram. It does not implement contiguous phrases, fuzzy typo correction or semantic/vector matching.

HTML title plus static body text are indexed. Markdown uses its display title and rendered static text, including code blocks and link labels. Extraction preserves continuity through inline nodes (`re<span>try</span>` becomes `retry`) and separates blocks. It skips head content other than the separately indexed title, scripts, styles, template/noscript subtrees, and nodes carrying `hidden`, `aria-hidden=true` (case-insensitive), or `data-search-ignore`. CSS visibility and script-created text are not evaluated; image alt attributes and path strings are not full-text fields. Existing metadata search continues to handle paths/filenames.

All result IDs are full source-relative document paths. Ordering is ascending UTF-8 path bytes, matching the Go artifact index; no relevance score, term frequency or positions are stored. The total covers the complete intersection, while `hits` contains only the requested page. Every path segment is URL-encoded independently for `href`.

## Projection and binary format v1

```text
_indexes/<site>/meta.json
_indexes/<site>/search/manifest.json          mutable entry point
_indexes/<site>/search/root-<sha256>.gz       dictionary, singleton IDs, path table
_indexes/<site>/search/leaf-<sha256>.gz       shared postings for a stable token bucket
```

The manifest contains `version: 1`, `site`, `documents`, `generation`, a `root` object reference, and exactly 128 `shards` entries. Unused shards are `null`. Each reference contains `url`, `sha256`, compressed `bytes`, and decoded `rawBytes`. `generation` hashes the deterministic Go-encoded manifest with an empty generation field; it covers root **and all leaves**. A posting-only change may leave the root hash unchanged while the generation changes. SHA-256 references hash actual gzip file bytes; compression does not include timestamps. URLs are confined to the selected site's search prefix.

Binary fields use unsigned LEB128 integers. Strings are UTF-8, front-coded against the previous string with byte-prefix length, suffix length, and suffix bytes. A prefix can split a UTF-8 code point; decode after reconstructing the complete string.

- Root starts with ASCII `GAPSR1`, document count, token count, and token entries. Each entry is a front-coded string followed by a reference: zero means external; otherwise ordinal = reference − 1 is the singleton document. The remaining entries are exactly `document count` front-coded paths in result order.
- Leaf starts with ASCII `GAPSL1`, document count, token count, and front-coded token entries with local posting-list ordinals. Then list count, followed by each list's byte length and bytes. Token routing is UTF-8 FNV-1a modulo 128.
- Posting starts with mode and cardinality. Mode 0 contains sorted document delta-varints (initial previous = 0); mode 1 contains `ceil(documents/8)` bitmap bytes, least-significant bit first; mode 2 contains run count followed by start delta from previous end and positive length; mode 3 contains delta-varints of the excluded documents; mode 4 means all documents and has no payload. The builder picks the shortest raw representation and interns identical lists within each leaf before gzip compression.

The browser checks blob digest and byte lengths before/after decompression, magic/version, bounds, UTF-8, path shape, list references and cardinality. Truncated or trailing data is rejected. It never treats a missing/corrupt shard as an empty partial result.

## Publication and updates

The existing provider-neutral publisher uploads changed source bytes first, immutable search blobs next, then `index.json`, search manifest and finally `meta.json`. Stale source/search objects are deleted afterward. Search files have `Content-Type: application/octet-stream`, no HTTP `Content-Encoding`, and the immutable cache policy. The client explicitly inflates the `.gz` file; automatic HTTP gzip decoding must not consume this format layer. Manifest/discovery/index JSON use the existing revalidation policy. No provider-specific APIs enter the search contract.

Local builds also expose blobs before the manifest and remove only old files owned by this format after writing metadata. Provider publish reconciles the owned search prefix. Failures reuse the existing lock/cache-retry mechanism; a retry converges without preserving unlimited generations. Publication remains eventually consistent, not atomic. An in-flight client pinned to a now-deleted generation refreshes its manifest once on HTTP 404 and reruns the whole search. Persistent errors are returned. A cache can still serve an earlier complete generation until revalidation; search does not guarantee a transactional snapshot of page bodies during concurrent publication.

## Verification and capacity

```sh
go test ./cli/internal/fulltext ./cli/internal/indexer ./cli/internal/publisher ./cli/cmd/artifact-pages
npm run test:fulltext
npm run build

# Optional: reuse the earlier generated real-page corpus.
npm run test:fulltext -- --scale-source \
  .local/fulltext-load/run-20261001101659717-648ba6c0/storage/_artifacts/load-50000
```

The browser script builds actual HTML/Markdown sources through Go, serves them over HTTP, and calls the TypeScript API in Chromium. Its test server supplies nginx-equivalent content-plane 404 behavior; Vite's normal missing-file SPA fallback is not a valid search-object response. Verification includes lazy requests, Unicode/AND/substring matches, path ordering/paging/encoding (including reserved characters and literal backslashes), site isolation, empty/disabled sites, checksum/version/scope rejection, HTTP failure/retry, shared-request cancellation, stale-generation recovery and 60-second refresh. Go tests cover deterministic generation, posting-only update identity, shared extraction, stale local cleanup, publication order, no-op and partial-failure convergence.

The 2026-10-01 core trial reused the 50,000-page corpus: approximately 6–7 seconds for the full metadata + search build, 221 KB root, and 5.40 MB stored search data including the manifest. The older research format measured 326 KB root and 5.59 MB search data. These are local controlled-corpus observations, not production traffic or provider delivery proof. Per-query API timings do not include UI paint; do not compare them directly to the earlier research form's input-to-paint measurements. The ticket records the latest actual run and evidence.

The root still includes the complete path table and singleton vocabulary. Resolving only displayed paths, dictionary partitioning, relevance metadata and naturally varied long Japanese corpora remain measured follow-ups, not prerequisites for a callable core.
