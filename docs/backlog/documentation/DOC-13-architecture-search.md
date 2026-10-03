# DOC-13 — Architecture: search and indexes

- Status: In progress
- Site: `architecture`
- Page: `ja/search.html`, `en/search.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-09, DOC-10

## Purpose

Explain how both searches work and why they are static: finding a page by name from the per-site artifact index, and optional page text search from a static, sharded projection built at publish time with `--fulltext`.

## Scope

- Finding by name: the active site's `index.json` loaded by the browser, client-side ranking (pins and recent reads, the precomputed profile for large sites), the blank-query list, and the `@`, `#`, `>` scopes.
- Page text search: `--fulltext` on every publish, `meta.json.fullTextUrl`, the manifest/root/leaf objects and their cache rules, fetching only after a committed query, NFKC/lowercase AND-substring semantics, path-ordered results, highlighting in the reader, and behavior when data changes mid-search.
- Trade-offs (no relevance ranking, no snippets, the root is always fetched, long unspaced Japanese, query-dependent payload) and the recorded capacity measurements with what each measured.
- Why it is static: no search service, same delivery and access gate, pay only when used.

## Out of scope

- Reader how-to and keyboard shortcuts (DOC-05).
- The binary format's byte-level encoding beyond what a reader needs to understand the trade-offs.

## Primary sources

- [Full-text core contract](../../architecture/fulltext-search.md), [Specification §5.2, §8 Search](../../specification.md)
- [Local load benchmark](../../research/fulltext-local-load-benchmark.md), [Feasibility](../../research/fulltext-search-feasibility.md), [Cost investigation](../../research/fulltext-search-cost.md), [Palette benchmark](../../research/palette-search-benchmark.md)
- `web/src/domain/fuzzy-search.ts`, `palette-scoring.ts`, `text-highlight.ts`, `web/src/data/fulltext.ts`; `cli/internal/indexer/palette_profile.go`; `cli/internal/publisher/site_publish.go`

## Acceptance criteria

- [x] `ja/search.html` and `en/search.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, number, and behavior matches the linked primary sources and current CLI help; each measurement states what it measured and that it is a local, controlled-corpus result.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish` (with `--fulltext`), and opened in the local reader; page text search works on the `architecture` site.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-02, drafted in the batch with DOC-08–DOC-13; awaiting independent and owner review)

- Published locally: `./artifact-pages site publish --site architecture --config artifact-pages.yaml --fulltext --dry-run`, then without `--dry-run`. `meta.json` advertises `/_indexes/architecture/search/manifest.json`.
- Playwright checked `ja` and `en` at 400 px and 1280 px in light and dark with the same criteria as DOC-08: no page-level overflow, no errors, links and fragments resolve (including `/guide/<lang>/reading.html#search`).
- In the reader, `/architecture/en/search.html?q=immutable leaf` listed 3 pages (“1 / 3”) and highlighted both terms in the open page.
- Numbers on the page are copied from the sources: 50,000-page core trial (about 6–7 s, 221 KB root, 5.40 MB search data); research benchmark cold input-to-paint medians 112.3 ms local / 1,485.1 ms constrained at 50,000 pages, 40.5 / 41.9 ms local at 1,000 / 10,000 pages, cold payloads 25.1–26.1 / 83.0–91.4 / 329.6–370.8 KB, warm medians 8.6–27.2 ms; palette benchmark 9.85 MB / 606 ms (chunked 606–621 ms) and 486 KB / 3.7 KB / 107.8 ms.
- Name-matching wording follows `fuzzy-search.ts` (each typed word must appear in order inside one word of the title or path; exact and prefix matches score higher). The ≥ 5,000-document scoring profile follows `paletteScoringProfileThreshold`.
- Review fixes (2026-10-02): Japanese terms aligned with the guide (認証情報, インデックス, 一覧 for the preview catalog) and no half-width spaces around ASCII terms in Japanese text; architecture→guide links are root-absolute logical routes with `target="_top"`. Republished with `site publish --site architecture --config artifact-pages.yaml --fulltext` (dry-run, then publish: 145 files synced, 101 stale removed, 246 revalidation paths). Playwright re-check of all 12 pages at 400/1280 px in light and dark: no overflow, no console/page errors, all 20 same-origin links 200, all fragments present; reader navigation, guide link, and `?q=immutable leaf` (3 pages) re-verified.
- Measurement table: the warm-search median 8.6–27.2 ms now has its own row stating it spans all six benchmark scenarios (three sizes × local/constrained).

## Notes

- Reading order places this page fourth (after Publishing model, before Previews) because it builds on the storage layout and the publish order.

## Second review fixes (2026-10-03, awaiting owner review)

- ja page list label プレビュー → プレビューの仕組み (no content change).
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
