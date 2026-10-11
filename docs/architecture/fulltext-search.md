# Static full-text search core

Implemented in [IMP-41](../backlog/implementation/IMP-41-fulltext-search-core.md). The palette keeps its metadata search and opens the results route for full-text queries; the route is defined in [TD20](../backlog/technical-design/TD20-search-results-page-and-snippet-packs.md) and [ISSUE-087](../backlog/issues/ISSUE-087-page-text-search-results-page.md). The additive section data below is the format contract for snippets; reader consumption remains in ISSUE-085.

## Build and publish

```sh
go run ./cli/cmd/artifact-pages index build \
  --site sre --source docs/artifacts --out .local/storage

# The existing registered-site syncer builds and reconciles the same data.
go run ./cli/cmd/artifact-pages site sync --site sre
```

Both operations always generate the site's full-text data, and `site sync` always publishes it; there is no option to omit it. The retired `--fulltext` flag and the Action `fulltext` input are not accepted (the CLI rejects the flag as an unknown flag, exit code 2). A site that has no extractable text or no documents still publishes a valid, empty manifest. This is part of the existing operations, not a separate search service or a requirement to install Node for the Go publisher.

A site can still lack `fullTextUrl`, for example one published by an earlier version or whose publish failed before the manifest was written. The reader treats such a site as having no page text search. A per-site opt-out set once by the administrator is recorded as a deferred decision in [TD7](../backlog/technical-design/TD7-per-site-fulltext-opt-out.md).

Discovery metadata includes:

```json
{ "fullTextUrl": "/_indexes/sre/search/manifest.json" }
```

The full artifact index is unchanged. Search can run without downloading it or retrieving original page bodies. It returns paths/IDs; display titles and other reader metadata can come from the active site's existing index.

## Calling the browser API

```ts
import { createSiteFullTextSearch } from './data/fulltext'

const search = createSiteFullTextSearch(siteMetadata) // no request

// Call for a committed or debounced nonblank query; the results route searches as the reader types.
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

Reader-side ranking (ISSUE-077, 2026-10-11): the core stays path-ordered and unranked. The web reader loads every hit when the total is at most 500 (one request, `limit` = total, within the client's 1000 per request cap) and orders pages by title match, heading match from `index.json` `toc`, then body-only, path order within a tier; above 500 it keeps the paged, path-ordered list. This ranking uses no new v1 data. The additive section-table and text-pack contract below supplies the body text needed for snippets; the reader behavior remains in ISSUE-085.

## Projection and binary format v1

```text
_indexes/<site>/meta.json
_indexes/<site>/search/manifest.json          mutable entry point
_indexes/<site>/search/root-<sha256>.gz       dictionary, singleton IDs, path table
_indexes/<site>/search/leaf-<sha256>.gz       shared postings for a stable token bucket
_indexes/<site>/search/sections-<sha256>.gz   optional section table (v1 extension)
_indexes/<site>/search/text-<sha256>.gz       optional body-text pack (v1 extension)
```

The manifest contains `version: 1`, `site`, `documents`, `generation`, a `root` object reference, and exactly 128 `shards` entries. Unused shards are `null`. Each reference contains `url`, `sha256`, compressed `bytes`, and decoded `rawBytes`. `generation` hashes the deterministic Go-encoded manifest with an empty generation field; it covers root, all leaves, and any present `sections`, `texts`, and `snippetLimits` values. A posting-only or body-only change may leave the root hash unchanged while the generation changes. SHA-256 references hash actual gzip file bytes; compression does not include timestamps. URLs are confined to the selected site's search prefix. The v1 manifest may add the optional `sections`, `texts`, and `snippetLimits` fields below; their absence is valid and means there is no section data. They do not change the root, leaf, posting, or path-table bytes.

Binary fields use unsigned LEB128 integers. Strings are UTF-8, front-coded against the previous string with byte-prefix length, suffix length, and suffix bytes. A prefix can split a UTF-8 code point; decode after reconstructing the complete string.

- Root starts with ASCII `GAPSR1`, document count, token count, and token entries. Each entry is a front-coded string followed by a reference: zero means external; otherwise ordinal = reference − 1 is the singleton document. The remaining entries are exactly `document count` front-coded paths in result order.
- Leaf starts with ASCII `GAPSL1`, document count, token count, and front-coded token entries with local posting-list ordinals. Then list count, followed by each list's byte length and bytes. Token routing is UTF-8 FNV-1a modulo 128.
- Posting starts with mode and cardinality. Mode 0 contains sorted document delta-varints (initial previous = 0); mode 1 contains `ceil(documents/8)` bitmap bytes, least-significant bit first; mode 2 contains run count followed by start delta from previous end and positive length; mode 3 contains delta-varints of the excluded documents; mode 4 means all documents and has no payload. The builder picks the shortest raw representation and interns identical lists within each leaf before gzip compression.

The browser checks blob digest and byte lengths before/after decompression, magic/version, bounds, UTF-8, path shape, list references and cardinality. Truncated or trailing data is rejected. It never treats a missing/corrupt shard as an empty partial result.

## Additive v1 section table and text packs

The writer may add these fields to the existing v1 manifest without changing `version`:

```json
{
  "sections": {"url": "/_indexes/sre/search/sections-<sha256>.gz", "sha256": "<64 lowercase hex>", "bytes": 123, "rawBytes": 456},
  "texts": [
    {"url": "/_indexes/sre/search/text-<sha256>.gz", "sha256": "<64 lowercase hex>", "bytes": 123, "rawBytes": 456}
  ],
  "snippetLimits": {
    "maxDocumentBytes": 262144,
    "maxSiteBytes": 33554432,
    "truncatedDocuments": [],
    "omittedDocuments": []
  }
}
```

`sections` and `texts` are either both present or both absent. When any section text is retained, `sections` is one object reference and `texts` is a non-empty array. If the site has no retained body text, both may be absent. The section reference's gzip member expands to compact UTF-8 JSON, with no leading/trailing whitespace or final newline:

```json
{"version":1,"documents":[{"path":"guide/start.md","sections":[{"heading":"","anchor":"","pack":0,"offset":0,"length":12},{"heading":"Retry","anchor":"md-retry","pack":0,"offset":12,"length":18}]}]}
```

The JSON member order is fixed as shown: table `version`, `documents`; document `path`, `sections`; section `heading`, `anchor`, `pack`, `offset`, `length`. The Go writer uses compact `encoding/json` output and its default string escaping. `version` is exactly `1`. Document rows are strictly ordered by the same UTF-8 path-byte order as the root path table and contain only documents with retained, non-empty body text. A title-only document has no row. A row's section list is in document order. It may begin with one lead section before any anchored heading; that section has empty `heading` and `anchor` and may appear only first. Every later section has a non-empty display heading and anchor and starts at an h1–h3 heading whose text and ID are recorded by the artifact index `toc`. h4–h6 and headings without a `toc` record stay in the current section. A heading that starts a section is also part of that section's text.

`heading` is the display text recorded by `toc`, and `anchor` is that exact display anchor; neither is normalized. They are labels and navigation data, not the bytes searched in a snippet. The section's text bytes are the static body text of that section, including its heading, with only whitespace folding applied: every maximal run of ECMAScript whitespace becomes one U+0020 SPACE, and leading and trailing spaces of each section are removed. No NFKC or lowercasing is applied. The display title is not copied into a section: v1 postings still index normalized title plus body, while the title remains in `index.json`. Thus a hit caused only by the title has no matching body section, no synthetic excerpt, and no heading anchor. A bodyless/title-only document also has no section row. A result whose path appears in `snippetLimits.omittedDocuments` has no stored body text because the site cap omitted it; the reader can distinguish this from a title-only hit.

`texts` is an optional, non-empty array of object references in pack order. Each `text-<sha256>.gz` expands to plain UTF-8 bytes, with no magic, length prefix, JSON wrapper, or separator. The bytes are the concatenation of the whitespace-folded display section strings in document/section order. This is storage concatenation only: a consumer keeps the section ranges separate and never matches across adjacent ranges. `pack` is a zero-based index into `texts`; `offset` and `length` are unsigned JSON integers measured in **bytes** of that pack's uncompressed payload, not Unicode scalar values, UTF-16 code units, or characters. Each section range is non-empty, in bounds, starts and ends on UTF-8 scalar boundaries, and decodes to valid UTF-8. Ranges cover each pack contiguously from byte zero to `rawBytes`, with no gaps, overlaps, or unreferenced packs. Documents are packed whole in root path order, and each pack may contain one or more documents.

The section table and every text pack use the same reference checks as root and leaf: the URL must be exactly `/_indexes/<site>/search/<kind>-<sha256>.gz`, where `<kind>` is `sections` or `text`; the lowercase SHA-256 covers the compressed bytes, and `bytes` and `rawBytes` match the compressed and decoded lengths. Each object is exactly one gzip member with no trailing bytes. Gzip uses DEFLATE level 9 (`BestCompression`) with zero modification time and empty name, comment, and extra fields; the OS header byte is 255. This fixes the gzip metadata and makes repeated output deterministic for the same raw bytes and Go compressor. It does not promise that a different Go compressor version will emit the same DEFLATE bitstream.

The section-table and text-pack verifier rejects unsupported table versions; malformed JSON, duplicate keys, wrong field types, unsafe/non-integer numbers, invalid UTF-8, duplicate or out-of-order document paths, a path absent from the root table, a repeated or misplaced lead section, invalid heading/anchor pairs, an invalid pack index, a range outside its pack, a range that splits a UTF-8 scalar, a non-contiguous range layout, an unreferenced pack, mismatched byte lengths or digest, a concatenated gzip member, and trailing compressed or decoded bytes. `sections` and `texts` must occur together; `texts` must be non-empty; the limit constants must be exactly 262144 and 33554432; and each path in the cap record must obey the stated root-membership and row-presence rules. Pack output is at most 262144 raw bytes. Core root and leaf validation remains unchanged and fails closed. Failures in optional snippet data follow the reader behavior below.

### Reader procedure

1. Fetch `sections` at most once per manifest generation and build a map from path to row; do not rely on row order.
2. Only for hits on the displayed results page, collect the rows' distinct `pack` values. Never fetch packs for all hits.
3. Fetch each distinct `texts[pack]` once per generation, caching by SHA-256. Verify its digest and sizes as for other blobs, then inflate it.
4. For each section, first slice the inflated `Uint8Array` at `[offset, offset+length)`, then decode that slice with `TextDecoder('utf-8', {fatal: true})`. Never convert byte offsets to UTF-16. All later positions (match, excerpt window, and highlight) are UTF-16 indexes into the decoded section string.
5. Match by segmenting the decoded section into extended grapheme clusters with `Intl.Segmenter` at grapheme granularity. Normalize each cluster with NFKC, lowercase, and whitespace folding; concatenate the normalized clusters while recording, for each normalized UTF-16 index, the source cluster's UTF-16 range. Query terms are the committed query split exactly as in Search semantics (normalize, then split on whitespace). A query term matches when its normalized form is a substring of the normalized section string within that one section; matches never cross sections. Map match ranges back to the display string through the recorded cluster ranges. Per-cluster normalization can rarely differ from the whole-string normalization used by postings; when no term matches in any section of a hit, that hit has no excerpt.
6. Choose the section with the most distinct matched query terms, breaking ties by earliest section. The first match is the earliest match position of any term in that section. The window is about 160 grapheme clusters in total, starting about 40 clusters before the first match (or at the section start), cut only at grapheme boundaries, with U+2026 HORIZONTAL ELLIPSIS where text was cut. All matches inside the window are highlighted as display-string UTF-16 ranges. The excerpt links to the section's `anchor`, or to the page itself for a lead section with an empty anchor. Show at most one excerpt per hit. A title-only hit has no excerpt. A hit in `omittedDocuments` has no excerpt; a match that existed only in text cut by the document cap is not observable and simply yields no excerpt.
7. Per results page, the request bound is one `sections` request per generation plus at most `min(hits on the page, number of packs)` pack requests. Each hit needing body text needs exactly one pack because documents are never split between packs.
8. Snippets do not change ordering. The ISSUE-077 order remains title, heading, body, then path; there is no ordering by number of matching sections.

### Snippet-data failure handling

A malformed, missing, or mismatching sections table or text pack (including a bad digest, sizes, JSON, ranges, or UTF-8) disables excerpts for the affected hits (a hit whose pack or any of its sections fails to verify or decode gets no excerpt), or for the whole page if the table is bad; search results are still shown, and the reader may log the failure. Core root and leaf validation is unchanged and still fails closed. A 404 on `sections` or a text pack causes one manifest reload, following the same rule as for v1 blobs. If the object is still missing or the generation is unchanged, show results without excerpts.

### Packing and caps

Each section's whitespace-folded display text is stored as that section's UTF-8 byte range; adjacent ranges are not normalized or matched as one string. For document-size accounting, the section byte lengths are summed, equivalent to concatenating them without delimiters. The per-document limit is 262144 UTF-8 bytes. A longer document is truncated to the largest UTF-8 scalar boundary at or below that byte limit; later sections disappear and the final retained section may be partial. The per-site limit is 33554432 raw text bytes across included packs, excluding the compressed bytes and section-table bytes. If adding a document's post-truncation text would exceed the site limit, that whole document is omitted; later documents are still considered and may fit. Omitted documents do not affect pack boundaries.

After appending a whole document, a soft pack boundary occurs when the pack has at least 16384 raw bytes and the first byte of `SHA-256(UTF-8 path)` has its low three bits clear (`byte & 0x07 == 0`, probability 1/8). The target is approximately 65536 raw bytes, not a guarantee; actual size depends on document sizes and sampled paths. Before adding a document that would take a non-empty pack above 262144 bytes, the writer closes the current pack even if it is below 16384 bytes. It closes a pack at exactly 262144 bytes and closes the final non-empty pack at end of input even when it is below the soft minimum. A document is at most 262144 bytes after the per-document cap, so it can always fit in an empty pack. These constants, the path hash, and the section serialization are fixed for this extension.

`snippetLimits` is present whenever `sections` or `texts` is present, and also when every candidate was omitted. The manifest extension keys are appended as `sections`, `texts`, `snippetLimits`; the record fields appear in the order shown. The two path fields are JSON arrays even when empty, sorted by UTF-8 bytes, and unique. Every listed path exists in the v1 root path table, and the arrays are disjoint. `truncatedDocuments` lists documents whose retained body is a prefix shortened by the per-document limit; each has a section-table row. `omittedDocuments` lists documents omitted by the site limit and therefore has no section row. A document omitted by the site limit is listed only in `omittedDocuments`, even if its untruncated source would also exceed the per-document limit. Each cap is non-fatal: the CLI warns with the affected document paths, and the v1 full-text index remains complete. If no body text is retained and no document is capped, all three optional fields MUST be absent. Missing `sections`/`texts` remains the v1 fallback: full-text results work but have no body snippets.

The packer is path-hash sampling at document boundaries, not a rolling content hash over text. A republish with the same paths, same whitespace-folded display section bytes, and same cap decisions produces the same raw packs and references under the same gzip implementation. A same-path content change with unchanged display-text byte lengths preserves boundary eligibility; the pack containing it still changes because the digest covers all bytes in that pack. A length change can move a soft or hard boundary and alter neighboring pack membership, offsets, and hashes until a later boundary is shared. Adding or removing a document can shift later partitions. Therefore unchanged documents keep identical pack objects only while their pack membership and preceding byte lengths remain stable; the format does not promise that only the changed document's pack changes. The `sections` reference and manifest generation may change even when some text packs remain reusable. Existing v1 root and leaf bytes stay unchanged; the v1 manifest generation changes to cover any new optional fields.

## Publication and updates

The existing provider-neutral publisher uploads changed source bytes first, immutable search blobs next, then `index.json`, search manifest and finally `meta.json`. Stale source/search objects are deleted afterward. Search files have `Content-Type: application/octet-stream`, no HTTP `Content-Encoding`, and the immutable cache policy. The client explicitly inflates the `.gz` file; automatic HTTP gzip decoding must not consume this format layer. Manifest/discovery/index JSON use the existing revalidation policy. No provider-specific APIs enter the search contract. When the writer lands, the publisher's managed search-blob pattern in `cli/internal/publisher/site_publish_state.go` (`sitePublishStateSearchBlob`, currently `(root|leaf)-<64hex>.gz`) must also accept `sections-<64hex>.gz` and `text-<64hex>.gz`.

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

The existing generated load corpus measured compact section tables at 289,711 raw / 20,468 gzip bytes for 1,000 documents, 2,927,208 / 201,108 bytes for 10,000, and 14,755,665 / 1,004,586 bytes for 50,000. The sites contain actual generated HTML and Markdown pages with three sections per document; tables were built in a throwaway script from the corpus sources and compressed with Go's level-9 gzip settings. These are controlled synthetic-corpus measurements.

The root still includes the complete path table and singleton vocabulary. Resolving only displayed paths, dictionary partitioning, relevance metadata and naturally varied long Japanese corpora remain measured follow-ups, not prerequisites for a callable core.
