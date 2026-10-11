# TD19 — Navigation metadata in the site index: author-defined order and page descriptions

- Status: Open
- Phase: Local index builder
- Decision: Pending owner. The recommendation below is the author's, not a decision.
- Related design: [TD2](TD2-component-release-policy.md) (schema versioning), [TD8](TD8-index-only-input-capture.md) (index-only input)
- Unblocks: [ISSUE-076](../issues/ISSUE-076-pages-sorted-alphabetically-by-title.md) (ordering), [ISSUE-082](../issues/ISSUE-082-no-previous-next-navigation.md) (previous/next), [ISSUE-078](../issues/ISSUE-078-landing-page-has-no-orientation.md) (start point, translation-aware counts), [ISSUE-075](../issues/ISSUE-075-directory-routes-have-no-page.md) (per-child descriptions on directory pages; the first version does not need this)
- Origin: the 2026-10-11 dogfooding of `artifact-pages.dev` and a competitive review of documentation readers.

## Design question

How does an author control the order of pages and folders and give each page a description, so the reader can show them in navigation, directory pages, the site home and previous/next links?

## Current state

- Each artifact in `index.json` carries `id`, `title`, `path`, `format`, `filename`, `artifactUrl`, `updatedAt`, `lastCommitter`, `source` and `toc` (`web/src/domain/index.ts:58-69`; Go `ArtifactIndexEntry` at `cli/internal/indexer/build.go:108-119`). There is no order and no per-artifact description. The site has an optional `description` (`SiteSummary`) supplied by configuration.
- The indexer takes the title from HTML `<title>` or the first H1 and builds `toc` from headings; it does not read Markdown front matter (a search of `cli/internal` and `docs/specification.md` finds none). HTML artifacts sampled on the live site carry a `<meta name="description">` that the index drops.
- The reader sorts every listing by `title.localeCompare` (`web/src/domain/tree.ts:63-68`, `ArtifactBreadcrumbs.tsx:317-319`). Folders have no metadata at all; the tree is derived from `path`.
- No language or translation notion exists in the specification or the indexer. The live sites keep translations in top-level `en/` and `ja/` folders by convention.

## Constraints

- **Schema versioning (TD2).** A format's `schemaVersion` changes only for a breaking change; additive changes keep it. The reader ignores unknown fields, so an optional new field (`order`, `description`) is a minor change: a newer CLI writes it, an older reader ignores it, and a newer reader treats its absence as the fallback. No republish is forced.
- **HTML and Markdown artifacts.** Most sampled artifacts are HTML, authored for the page, not for the index; any mechanism that needs front matter alone would leave them out. A mechanism must work for both formats.
- **Ownership.** The CLI indexer is Codex-owned; the web reader is Claude-owned. The schema is the interface between them: agree the field names and semantics here before either side builds.
- **Determinism.** The index must be reproducible from the source tree and Git history, like the rest of `index build`.

## Options: ordering

| Option | Author effort | Works for HTML | Folder order | Trade-offs |
| --- | --- | --- | --- | --- |
| A. Numeric filename prefix (`01-intro.html`) | Lowest; visible in the file list | Yes | Yes (`01-guide/`) | The prefix leaks into URLs and paths unless stripped, and renaming breaks links; the index needs a stripping rule. Familiar from Docusaurus and many static site generators. |
| B. Per-artifact field (`order`) from front matter (Markdown) or `<meta name="artifact:order">` (HTML) | Medium; one edit per page | Yes, with a meta tag | No (needs a folder mechanism) | Keeps URLs stable; order is spread over many files, so inserting a page means editing neighbours. |
| C. Per-directory nav file (`_nav.yml`, `.pages`) listing children in order | Medium; one file per folder | Yes | Yes, plus optional folder titles and descriptions | One place to see and change order; MkDocs `.pages` and Nextra `_meta` use this model. The file is not an artifact and must be excluded from publishing; stale entries need a rule. |
| D. README or index page link order | Low if the page exists | Partial | Needs a README per folder | Couples order to prose; order is inferred from links, which is fragile. Only works where an index page already exists. |

## Options: descriptions

| Option | Source | Trade-offs |
| --- | --- | --- |
| 1. Index `description` from front matter or `<meta name="description">` | Authored | Highest quality; absent when the author does not write it. Needs the indexer to parse front matter (new). |
| 2. Fallback: first non-heading paragraph, truncated (~160 characters) | Computed at index build | No authoring needed; quality varies, markup and navigation text must be stripped, and it duplicates content in `index.json` (size grows with pages; check the index budget). |
| 3. Reader computes it from full-text data | Computed in the browser | Not available: the search data stores tokens and postings, not text (`docs/architecture/fulltext-search.md`, "Search semantics" and "Projection and binary format v1"). |

## Author's recommendation (not a decision)

- **Order:** C for folders and for explicit control, with B as the per-file escape hatch, and the filename sort as the deterministic fallback; skip A as the primary mechanism to avoid prefixes in URLs. If the owner prefers the smallest first step, B alone (a per-artifact optional `order`) unblocks ISSUE-076 and ISSUE-082 for the sampled sites, but cannot order folders or describe them.
- **Descriptions:** option 1 with option 2 as the fallback, emitted as an optional `description` string per artifact; folders get `title` and `description` from the nav file in option C.
- **Language:** do not add a language field in this change; decide how translations are detected or declared in ISSUE-078 once the order and nav-file shape exist.
- **Schema:** additive optional fields only, no `schemaVersion` change, documented in the specification and the compatibility fixtures per TD2.

## Open questions for the owner

- Which ordering mechanism, and may it cost authors a file per folder?
- Should folder titles and descriptions be authored (nav file) or only derived from names?
- Is a first-paragraph fallback acceptable given the index-size cost?
- Who sequences the work: the CLI indexer first (Codex), then the reader (Claude), announced in `STATUS.md`.

## Settled contract

None yet.
