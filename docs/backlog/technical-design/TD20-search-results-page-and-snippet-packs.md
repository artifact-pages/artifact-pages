# TD20 — Search results page and build-time snippet packs

- Status: Open
- Phase: Reusable distribution
- Decision: Direction accepted by the owner on 2026-10-11 (results page, build-time packs); pack size and h4 handling confirmed with the defaults on 2026-10-12.
- Related design: [TD2](TD2-component-release-policy.md) (additive schema changes), [TD19](TD19-navigation-metadata-in-the-site-index.md) (index metadata; same additive approach)
- Subsumes: [ISSUE-085](../issues/ISSUE-085-page-text-search-snippets.md) (snippets). Builds on [ISSUE-077](../issues/ISSUE-077-fulltext-results-unranked.md) (reader-side ranking).
- Origin: owner feedback of 2026-10-11 on the live sites.

## Design question

How does the reader show where a page matched, in a space wide enough to read, without raising the request count or per-query cost?

Today a body-only hit in the sidebar reads "Text" and nothing more, and the sidebar is too narrow for anything longer. No UI can fix that alone: the v1 index stores postings, not text.

## Current state

**Format v1** (`cli/internal/fulltext/build.go`, `web/src/domain/fulltext-codec.ts`, `docs/architecture/fulltext-search.md`):

- `/_indexes/<site>/search/manifest.json` holds `version: 1`, `generation`, `site`, `documents`, a `root` reference and exactly 128 `shards` references (`null` when a shard is unused). A reference is `{url, sha256, bytes, rawBytes}`; the URL must be `/_indexes/<site>/search/<kind>-<sha256>.gz`, and the reader checks length, SHA-256 of the compressed bytes and decoded length.
- `root-<sha>.gz` (`GAPSR1`) holds the token lexicon and the front-coded document paths. A token with a single document stores its id inline; others route to one of 128 leaves by FNV-1a modulo 128. `leaf-<sha>.gz` (`GAPSL1`) holds tokens and interned posting lists in one of five encodings.
- Each document is one record: the display title plus the normalised static body text (`indexer/build.go:271`, `Title + " " + searchText`). The text is split on spaces into tokens; only "token occurs in document" survives. There are no positions, frequencies, headings or text. Search is an AND of whitespace-separated substring terms over the lexicon.
- `normalize` is NFKC, lowercase, whitespace folded to single spaces (the Go and TypeScript implementations mirror each other). Document ids are positions in the path-sorted list.
- Objects are served `application/octet-stream` with the immutable cache policy; the manifest is revalidated (the reader treats a loaded generation as fresh for 60 seconds). A first query costs the manifest, the root and one leaf per distinct shard the terms route to (at most six in flight).
- The reader ranks hits from `index.json` titles and `toc` (ISSUE-077), so a body-only hit has no reason beyond "Text".
- Heading anchors exist only in the indexer: `toc` lists h1–h3 that have an `id` and non-empty text (`readArtifactHTMLDocumentNode`). HTML keeps the author's ids, so a heading without an id has no entry. Markdown headings get a GitHub-style slug prefixed `md-`, de-duplicated against explicit ids (`assignMarkdownHeadingIDs`). The reader links to the ids in `toc`; it does not assign its own.

**Reader UI** (`web/src/components/PageTextSearch.tsx`, `web/src/domain/text-highlight.ts`): the sidebar field commits a query on Enter and keeps it in `?q=` on the site route; results replace Pinned/Browse; a "Search only in <folder>/" chip scopes the list; the open page highlights terms with the CSS Custom Highlight API and scrolls to the first match.

**Facts that shape the proposal.**

- Routing is History API paths plus a query string (`web/src/routing.ts`, `App.tsx`: `/<site>/<path>?q=…`), not hash routes.
- Sidebar search commits on Enter today, so "results update as you type" is a behaviour change and the specification paragraph that starts "the sidebar's search field takes a committed query" must be rewritten.
- Only headings that carry an id get an anchor; the `toc` skips the rest.
- The publisher is strict about search keys: `sitePublishStateSearchBlob = ^(root|leaf)-[0-9a-f]{64}\.gz$` (`cli/internal/publisher/site_publish_state.go:29`, used at :377) is the only accepted shape, so `text-` and `sections-` keys have no HTTP policy and fail state validation today.
- `Generation` is the SHA-256 of the whole manifest with an empty generation field (`cli/internal/fulltext/build.go`, end of `Build`), so new manifest fields change it; the reader's 60-second freshness window is unaffected.
- The search manifest has no Go decoder in `cli/internal` (only `json.Marshal` in `Build`), and the TypeScript `parseManifest` casts without rejecting unknown fields, so extra fields are tolerated on both sides.

## Constraints

- **TD2.** A format's `version` changes only for a breaking change; additive objects keep it. A v1 reader ignores unknown manifest fields, so old readers keep working and new readers treat their absence as "no snippets".
- **Request count and cost.** Minimise requests and bytes per query by moving work to build time. Static hosting only; no backend.
- **Stability.** Content-addressed objects are only cheap if a republish leaves untouched objects byte-identical.
- **Ownership.** The format and the indexer are Codex-owned (`cli/`); the UI and client-side snippet code are Claude-owned (`web/`).

## Proposal (author's recommendation)

### 1. UX split

- **Sidebar filter: title and path only.** It becomes navigation again and needs no search data. It ends with a row "Search full text for “q” ↵" that opens the results page.
- **Results page** in the main content area at `/<site>/_search?q=…&in=<folder>`. This follows the `_previews` precedent. The first segments `_previews` and `_search` are reserved so the reader's route namespace and directory pages stay unambiguous: a directory page for a `_search/` folder would be shadowed by the search route, and documents under `_previews/` would be shadowed by the preview routes. The specification reserves both and the indexer rejects them ([ISSUE-088](ISSUE-088-indexer-rejects-reserved-first-segments.md)). Per result: title, path, the heading the match sits under (linking to its anchor), one or more highlighted snippets. Folder facets with counts replace the "Search only in <dir>/" chip (`in` carries the choice). Results update as the reader types (debounced; stale responses dropped as the core contract already requires), and the URL is shareable; Back returns to the previous query or page.
- **⌘K palette** keeps jumping to titles and headings and gets a "Search full text" fallback entry.
- **Destination page:** the existing highlight is extended with a "1/5 ↑↓" match navigator. A result link carries `?q=` so the target highlights and scrolls as it does today.
- ISSUE-085 is subsumed; ISSUE-077 ranking stays and snippets add a body-hit order (more matching sections first, then path). (Amended 2026-10-12: snippets do not reorder hits; see the Reader procedure in docs/architecture/fulltext-search.md.)

### 2. Rejected: fetch each hit's page in the browser

Up to about 20 extra requests per page of results, each the full HTML or Markdown bytes, one poorly shared cache object per page. It avoids a format change but spends what the owner wants to save.

### 3. Format: additive section table and text packs

The indexer already extracts each document's text for v1. It additionally:

1. **Splits each document into sections at h1–h3** (the levels the `toc` already uses). A section is a heading text, the heading's anchor id (the same id that `toc` records; a heading without an id, or any text before the first heading, joins the preceding section or the lead section with no anchor) and the section's text. The text is the section's display text with only whitespace folded (amended 2026-10-12, owner: excerpts show the original text, not the lowercased NFKC form); the browser normalises it per grapheme cluster at match time and maps highlights back to the display text, as specified in `docs/architecture/fulltext-search.md` (Reader procedure). `text-highlight.ts` keeps working for the destination page.
2. **Writes a section table**: per document, an ordered list of `(heading, anchor, pack, offset, length)`.
3. **Writes text packs**: section text concatenated into gzip objects `/_indexes/<site>/search/text-<sha256>.gz`.

Manifest additions (both optional, same `ObjectRef` shape and the same URL, length and SHA-256 checks as `root` and `leaf`):

- `sections`: the section table.
- `texts`: the list of pack references, in pack order.

**Where the section table lives.** Inside the root would make every query pay for headings and offsets and would change the `GAPSR1` layout. A separate `sections-<sha>.gz` leaves the root and the first query (manifest, root, leaves) exactly as today; the results page fetches the table once per generation, in parallel with its first leaf request. Recommendation: the separate object.

**Pack layout (content-defined chunking over path order).** Documents are visited in path order and a pack is closed after a document when `hash(path)` meets a mask and the pack has at least the minimum size, or unconditionally at the maximum. The constants are fixed, not derived from the site size: minimum 16 KiB, target about 64 KiB (the mask), maximum 256 KiB of raw text.

- Folder locality comes from path order alone; packs are not cut at folder changes.
- A republish reuses pack objects for unchanged documents only while their pack membership and preceding byte lengths stay stable. A same-path content change with unchanged display-text byte length preserves boundary eligibility; a length change can move a soft or hard boundary and affect later pack membership until a later boundary is shared. A change to the constants reshuffles every pack, so the constants are part of the format and change only with a new format revision. (Amended 2026-10-12, owner: a length change can shift later pack boundaries, so reuse holds only while pack membership and preceding byte lengths are stable.)
- Stability also needs deterministic gzip: fixed compression level, no mtime, no file name (the v1 objects already satisfy this), so identical input gives identical bytes and hash.
- Same delivery as the leaves: `application/octet-stream`, no `Content-Encoding`, the immutable cache policy, reconciled with the rest of the owned search prefix.

**Limits.** A per-document text cap (proposed 256 KiB of display text (UTF-8 bytes); longer sections are truncated) and a per-site cap on total raw pack bytes (proposed 32 MiB). Exceeding a cap never fails the publish and is never silent: the CLI prints a warning, and the manifest records that snippets were omitted for the site, or which documents were truncated. (Owner 2026-10-18: the 32 MiB site budget and its path-order omission stay fixed as an accepted constraint, see [ISSUE-111](../issues/ISSUE-111-snippet-budget-omits-late-documents-at-scale.md) and the specification's "Snippet budget at scale".) With `sections` and `texts` omitted the UI falls back to v1 behaviour ("Text", no snippet); the sidebar and ranking are unaffected.

### 4. Runtime cost

For a results page of 20 hits the reader reads the section table, picks the sections of those documents that contain the query terms, and fetches only the distinct packs holding them. Snippets and per-page match lists are computed in the browser as specified in the Reader procedure of `docs/architecture/fulltext-search.md` (terms matched per grapheme cluster against the display text, a window of about 160 grapheme clusters around the first match). Packs are cached across queries and, by content addressing, across publishes.

Rough figures for a ~100-page documentation site (about 5 KB of text per page, about 500 KB normalised, about 150 KB gzipped, about 800 sections; estimates to confirm on the real corpus in the first slice):

| | Requests per query (after manifest and root) | Transfer per query | Stored overhead |
| --- | --- | --- | --- |
| v1 today (no text) | 1 to 6 leaves | tens of KB | none |
| Runtime page fetch (rejected) | up to 20 pages, uncached on first view | 20 full pages, often 0.5 to 3 MB | none |
| Section table plus packs | table once per generation, plus typically 1 to 4 packs | table about 16 to 32 KB raw (20 to 40 bytes per section; perhaps a third of that gzipped, unmeasured); packs hold the 500 KB in about 8 objects | about the gzipped plain text of the site, 150 KB here |

Honest reading: on a site this small, 1 to 4 of 8 packs can be a large share of all the text, so the first results page may transfer most of it. That is still far fewer requests and bytes than fetching 20 pages, and every pack is immutable and cached, so repeat queries and later publishes cost little. At 1,000 pages the stored text is roughly ten times larger and the pack count per page of results stays bounded by the page size, but the section table grows linearly and is fetched whole once per generation.

### 5. Slicing and order

Slice 1 ships value without any format change, and is accepted churn: it is rebuilt when headings and snippets arrive (it shows titles, paths, folder facets and counts only).

1. A new web ISSUE: results page route, sidebar filter change, palette fallback, folder facets, as-you-type search, and the rewrite of the specification's page text search paragraph, on v1 data. (Claude)
   - Before it ships: a small Codex item for the reserved first-segment check in the indexer.
2. A new IMP (Codex): section table and text packs in the indexer, manifest `sections` and `texts`, limits and warnings, deterministic packing, and publisher reconciliation. The last includes extending `sitePublishStateSearchBlob` (and the object-policy mapping it feeds) to `text-` and `sections-`. Until then the publisher rejects the new keys.
3. ISSUE-085 (Claude): snippet and heading extraction from packs, the match navigator, truncation and over-cap fallback, body-hit ordering.

Older CLIs: a pre-change CLI builds only v1 objects. On a site that already has `text-` or `sections-` objects it either converges back to v1 (reconciliation deletes search keys missing from its desired set, `site_publish.go`) or fails closed, because its publish-state validation rejects state rows for those keys (`validateSitePublishRow`). Operators upgrade the CLI before the first republish. This is acceptable under 0.x (TD2). The settled format wording will live in `docs/architecture/fulltext-search.md`.

## Owner decision (2026-10-11)

The owner chose the results page (option A over snippets in the sidebar) and build-time packs over fetching pages at runtime, after reviewing this monthly cost estimate (estimates; third-party price summaries except the CloudFront Japan request rate; assumed ~3 requests/60 KB per page view and per-query figures measured from the live v1 index):

| Monthly views / searches | Cloudflare (R2 + cache) | AWS v1 | AWS + packs | AWS + runtime page fetch |
| --- | --- | --- | --- | --- |
| 2k / 500 | $0 | $0 | $0 | $0 |
| 100k / 20k | $0 | $0 | $0 | $0 |
| 5M / 1M | $0 | ~$13 | ~$15 | ~$39 |
| 20M / 5M | $0 | ~$140 | ~$165 | ~$360 |

AWS figures are CloudFront pay-as-you-go (Japan) after the free 10M requests and 1 TB, plus CloudFront Functions; WAF adds about $0.60 per million requests. On Cloudflare the choice does not change cost; packs mainly cut round trips there.

## Resolved questions

- **Pack target size.** 64 KiB raw, or larger (fewer requests, less cache reuse)?
  Resolved (2026-10-12): the pack constants stay at minimum 16 KiB, target about 64 KiB, maximum 256 KiB, as in the contract.
- **Sections.** Do h4 headings also start a section (finer anchors, larger table), or stop at h3 to match `toc`?
  Resolved (2026-10-12): h4–h6 stay inside the current section; sections start at h1–h3 only.

## Settled contract

None yet.
