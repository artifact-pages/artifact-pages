# Page text search results are unranked, have no snippets, and mix languages

- Status: Done
- Assignee: Claude
- Priority: P1
- Area: Page text search results (`web/src/components/PageTextSearch.tsx`, `web/src/domain/fulltext-codec.ts`); search format (`cli/internal/fulltext`, Codex-owned)

## Problem

Results come back in path order with title and filename only. A reader who searches for a task cannot see why a page matched, and the best page can sit below weaker ones. When translations live in parallel folders, one English query lists each page twice.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev` (guide site).

1. Search `cloudflare` (sidebar search, Enter). "10 pages contain "cloudflare"", grouped `en/` then `ja/`, alphabetical. For "how to configure Cloudflare" the best page (Getting started, section "Start with Cloudflare") is third. No result says why it matched.
2. Search `preview`. 10 pages (5 `en/`, 5 `ja/`). The Japanese pages match, likely because they contain the English word (likely cause, not verified).
3. Search `プレビュー`. Returns only the 5 Japanese pages and works well.
4. On open, the matched word is highlighted in the page and scrolled to; the list persists. Those behaviors are good and must be kept.

Confirmed in code and documents: results are path-ordered by design (`PageTextSearch.tsx:374` "Results arrive in path order", `docs/specification.md:473` "Ranking and snippets are not provided", `docs/architecture/fulltext-search.md:61` "no relevance score, term frequency or positions are stored"). The Reading page of the Guide documents this. So this is a known limit, filed here because it is the largest friction in finding a task by text. Path-ordered, folder-grouped results are also the interaction the owner agreed on 2026-10-02 in [IMP-42](../implementation/IMP-42-fulltext-search-ux.md) ("Agreed interaction"); changing the order amends that agreement and needs the owner's confirmation.

Feasibility constraints (from the format contract): the client has no body text, term frequencies or positions, so body-hit counts and snippets cannot be computed from the existing search data. What the web already has: page titles and H2 headings in `index.json` (`toc`), which allow a title-hit and heading-hit tier without any format change.

## Expected outcome

Results are ordered by relevance, show why they matched, and can be scoped by language or folder.

## Owner decision (2026-10-11)

Chosen from the Storybook `Concepts/Reader UX 2026-10`/ISSUE-077 stories: variant B, a ranked flat list with a match-reason line ("Title", "Heading: <heading>", "Text"). This amends the IMP-42 agreed interaction (path-ordered folder groups); the owner approved the change on 2026-10-11. The folder scope chip is off by default and offered only when the open page sits in a folder. Ranking loads all hit pages first and falls back to path order above a recorded threshold. No snippets in this step.

## Acceptance criteria

- [x] First step, web-side only (no search format change): results are ranked by (title match, then heading match from `index.json` `toc`, then body-only match) while keeping path order within a tier. The tier is not shown as a numeric score; a match-reason label (Title / Heading: … / Text) is shown. Unit tests cover the tiers. Constraint: the search contract returns path-ordered results paged 20 at a time (`docs/specification.md:473`, `:475`; `docs/architecture/fulltext-search.md:61`), so tier ranking needs every hit page loaded before ordering. The cost is bounded by the site's `documents` count; record the threshold above which ranking falls back to path order. Verified: `web/src/domain/search-ranking.ts` with `web/src/domain/search-ranking.test.mjs` (run by `npm run test:reader-shell`, which CI does not run yet); threshold 500 matching pages (`RANKING_MAX_HITS`), one request with `limit` = total (client cap 1000); above it the list stays path-ordered, grouped by folder and paged; e2e covers order, reasons and the fallback.
- [x] Optional scope: a control to search only the open page's folder (for example `en/`) or to prefer the current folder's results; default and persistence decided in the issue (decided: off by default, not persisted, resets with the next query, offered only for a page inside a folder, limited to ranked lists because a partial list cannot be scoped honestly). Language detection by path is a convention, not a data model (see [ISSUE-078](ISSUE-078-landing-page-has-no-orientation.md)); the scope is folder-based.
- [x] A match snippet per result and body-hit ranking need either extra fulltext data (term frequency or a stored excerpt, a search format change owned by the CLI side with versioning per TD2) or a client fetch of each result page. Decide in a short design note (amend `docs/architecture/fulltext-search.md`) before implementing; split a follow-up issue if the format changes. Do not claim snippets in the first step.
- [x] The result header (currently truncated in the narrow sidebar, "10 pages contain "previe…") still shows the query and "n / total".
- [x] Specification updated (`docs/specification.md:473`, `:475`): ranking, paging and the "n / total" position, with committed query in `?q=`, highlight and scroll-to-first-match unchanged.

## Status note (2026-10-11)

Implemented and verified except the snippet criterion. Its decision part is made: snippets and body-hit ranking need a search format change or a client fetch per result, the owner chose no snippets for this step, and the design note is in `docs/architecture/fulltext-search.md`. The decision is recorded and the format/snippet work is split out as [ISSUE-085](ISSUE-085-page-text-search-snippets.md), so this item is Done.
