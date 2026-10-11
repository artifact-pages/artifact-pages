# TD20 — Search results page and build-time snippet packs

- Status: Proposed — waiting for owner decision
- Phase: Reusable distribution
- Decision: Pending owner. The recommendation below is the author's, not a decision.
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

**Where this brief and the code differ.** The routing is History API paths plus a query string (`web/src/routing.ts`, `App.tsx`: `/<site>/<path>?q=…`), not hash routes, so the results page is proposed as a path-style route (below), not `#/search`. Sidebar search currently *commits on Enter*; the "results update as you type" behaviour below is a change to that, and the specification paragraph for page text search must be rewritten. Per-heading anchors exist only for headings that carry an id.

## Constraints

- **TD2.** A format's `version` changes only for a breaking change; additive objects keep it. A v1 reader ignores unknown manifest fields, so old readers keep working and new readers treat their absence as "no snippets".
- **Request count and cost.** The owner wants fewer requests per query, and the cost moved to build time. Static hosting only; no backend.
- **Stability.** Content-addressed objects are only cheap if a republish leaves untouched objects byte-identical.
- **Ownership.** The format and the indexer are Codex-owned (`cli/`); the UI and client-side snippet code are Claude-owned (`web/`).

## Proposal (author's recommendation)

### 1. UX split

- **Sidebar filter: title and path only.** It becomes navigation again and needs no search data. It ends with a row "Search full text for “q” ↵" that opens the results page.
- **Results page** in the main content area at `/<site>/_search?q=…&in=<folder>`. This follows the `_previews` precedent: a reserved first segment under the site; the reserved name must be added to the path rules so no page can collide with it. Per result: title, path, the heading the match sits under (linking to its anchor), one or more highlighted snippets. Folder facets with counts replace the "Search only in <dir>/" chip (`in` carries the choice). Results update as the reader types (debounced; stale responses dropped as the core contract already requires), and the URL is shareable; Back returns to the previous query or page.
- **⌘K palette** keeps jumping to titles and headings and gets a "Search full text" fallback entry.
- **Destination page:** the existing highlight is extended with a "1/5 ↑↓" match navigator. A result link carries `?q=` so the target highlights and scrolls as it does today.
- ISSUE-085 is subsumed; ISSUE-077 ranking stays and snippets add a body-hit order (more matching sections first, then path).

### 2. Rejected: fetch each hit's page in the browser

The browser could download each hit's HTML or Markdown and extract text. That costs up to about 20 extra requests per page of results, transfers the full HTML bytes (markup, inline CSS and scripts included), caches poorly (one object per page, text extraction repeated), and exercises the artifact origin from the reader. It avoids a format change but spends exactly what the owner wants to save.

### 3. Format: additive section table and text packs

The indexer already extracts each document's text for v1. It additionally:

1. **Splits each document into sections at h1–h3** (the levels the `toc` already uses). A section is a heading text, the heading's anchor id (the same id that `toc` records; a heading without an id, or any text before the first heading, joins the preceding section or the lead section with no anchor) and the section's text. The text is normalised with the same `Normalize` as the index, so the browser matches query terms against it exactly as the core does, and `text-highlight.ts` keeps working for the destination page.
2. **Writes a section table**: per document, an ordered list of `(heading, anchor, pack, offset, length)`.
3. **Writes text packs**: section text concatenated into gzip objects `/_indexes/<site>/search/text-<sha256>.gz`.

Manifest additions (both optional, same `ObjectRef` shape and the same URL, length and SHA-256 checks as `root` and `leaf`):

- `sections`: the section table.
- `texts`: the list of pack references, in pack order.

**Where the section table lives.** Two options:

| Option | First query | Trade-offs |
| --- | --- | --- |
| A. Inside the root (`GAPSR2`-style trailer) | Unchanged: manifest, root, leaves | The root grows by headings and offsets for every document, and every query pays for it, snippets or not; a v1 reader would fail on the magic if the layout changed, so the root would need a new object anyway. |
| B. Separate `sections-<sha>.gz` | Unchanged for matching; one extra request only when the results page is first shown | The root stays as it is and v1 readers are untouched; the section table (about 20 to 40 bytes of compressed heading text and offsets per section) is fetched once per generation, in parallel with the leaves. |

Recommendation: **B**. The first query keeps today's request count; the results page fetches the section table together with its first leaf request, so the wall-clock path is no longer.

**Pack layout.**

- Target raw size about 64 KiB per pack (tunable; see open questions).
- Documents are assigned to packs in path order, so pages of one folder share packs and a folder-scoped result needs few packs.
- Boundaries must survive unrelated edits. Cut by key, not by running byte count: start a new pack when a document's path hash falls below a threshold chosen to give the target size on average, or at a change of the first path segment, whichever comes first. A rolling "fill to 64 KiB" cut would shift every later boundary after one page grows.
- The result: a republish rewrites only the packs containing changed documents (plus the section table and manifest). Unchanged packs keep the same hash, and a reader or CDN with them cached does not refetch them.
- Same delivery as the leaves: `application/octet-stream`, no `Content-Encoding`, the immutable cache policy, reconciled with the rest of the owned search prefix.

**Limits.**

- A per-document text cap (proposed 256 KiB of normalised text; longer sections are truncated and the cap is recorded in the section table so the UI can say "truncated").
- A per-site cap on total raw pack bytes (proposed 32 MiB). Over it, the indexer omits `sections` and `texts` and the UI falls back to the v1 behaviour ("Text" with no snippet). The sidebar and ranking are unaffected.

### 4. Runtime cost

For a results page of 20 hits the reader reads the section table, picks the sections of those documents that contain the query terms, and fetches only the distinct packs holding them. Snippets and per-page match lists are computed in the browser by finding normalised terms in the section text and cutting a window (about 160 characters) around the first match. Packs are cached across queries and, by content addressing, across publishes.

Rough figures for a ~100-page documentation site (about 5 KB of text per page, 500 KB normalised, about 150 KB gzipped; estimates to confirm with the real corpus in the first slice):

| | Requests per query (after the manifest, root) | Transfer per query | Stored overhead |
| --- | --- | --- | --- |
| v1 today (no text) | 1 to 6 leaves | tens of KB | none |
| Runtime page fetch (rejected) | up to 20 pages, uncached on first view | 20 full pages: often 0.5 to 3 MB | none |
| Section table plus packs | table (once) plus typically 1 to 4 packs | table about 5 to 10 KB; packs 20 to 60 KB gzipped each, mostly cached on repeat queries | about the compressed plain text of the site: 150 KB here |

A site of 1,000 pages is roughly ten times the stored text but keeps the per-query cost shape: the number of packs is bounded by the page size of the results, not by the site.

### 5. Slicing and order

Order matters: the first slice ships value without any format change.

1. `web`: results page route, sidebar filter change, palette fallback, folder facets, as-you-type search, match navigator, on v1 data only. No snippets; the heading is unknown, so rows show title, path and the existing match reason. (Claude)
2. `cli`: section table and text packs in the indexer, manifest `sections` and `texts`, limits, publisher reconciliation, fixtures and the architecture and specification wording of the format. (Codex)
3. `web`: snippet and heading extraction from packs, truncation and over-cap fallback, ranking of body hits. (Claude)

Names only for now (no issue files yet): `search-results-page`, `fulltext-section-packs`, `search-result-snippets`.

## Open questions for the owner

- **Pack target size.** 64 KiB raw, or larger (fewer requests, less cache reuse)?
- **Sections.** Do h4 headings also start a section (finer anchors, larger table), or stop at h3 to match `toc`?
- **Caps.** Are 256 KiB per document and 32 MiB per site acceptable, and should exceeding the site cap fail the publish instead of silently dropping snippets?

## Settled contract

None yet.
