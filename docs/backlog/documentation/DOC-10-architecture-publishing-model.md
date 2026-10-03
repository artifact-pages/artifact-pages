# DOC-10 — Architecture: publishing model

- Status: In progress
- Site: `architecture`
- Page: `ja/publishing-model.html`, `en/publishing-model.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-09

## Purpose

Explain how publishing converges: desired-state synchronization, digest-based change detection, idempotent retry, locks, registry eligibility, and concurrent publish/unregister.

## Scope

- The plan/apply sequence and what dry-run shows.
- Failure and retry behavior; why there is no rollback transaction.

## Out of scope

- CLI usage (DOC-04).

## Primary sources

- [Specification §5 Publishable source directory, §11 concurrent publish and unregister, §17 object-prefix reconciliation](../../specification.md), [T14](../verification/T14-production-reconciliation.md)

## Acceptance criteria

- [x] `ja/publishing-model.html` and `en/publishing-model.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-02, drafted in the batch with DOC-08–DOC-13; awaiting independent and owner review)

- Published locally: `./artifact-pages site publish --site architecture --config artifact-pages.yaml --fulltext --dry-run` (146 planned creates), then the same command without `--dry-run` (`PUBLISHED`). `meta.json` advertises `fullTextUrl`.
- Playwright (throwaway script outside the repo) opened every architecture page in `ja` and `en` directly under `/_artifacts/architecture/…` at 400 px and 1280 px in light and dark: no page-level horizontal overflow, no page or console errors, one localized H1 and `<title>` per page, `lang` set, the site page list marks the current page, every same-origin link (including the language switch, previous/next, cross-links, and links to `/guide/<lang>/…`) returns 200, and every in-site `#fragment` exists. Wide diagrams scroll inside their own frame and only then become keyboard-focusable.
- In the reader at http://localhost:4179: the site picker lists Architecture; Next moved the app to `/architecture/en/storage-layout.html`; the language switch moved it to `/architecture/ja/storage-layout.html`; a guide link moved it to `/guide/en/access-and-trust.html`; `?q=immutable leaf` listed 3 pages and highlighted the terms in the open page; at 400 px the framed page has no horizontal overflow.
- Facts checked against specification §5 (publishable source directory), §11 (concurrent publish and unregister), §17 (object-prefix reconciliation), `cli/internal/publisher/site_publish.go` (order: local-storage overlap preflight, lock, origin registry check, local build, listings and digest/metadata comparison, retry record, uploads in rank order, stale deletion, preview catalog reconciliation, invalidation, retry-record deletion, release), CLI help, and T14/T5/T15.
- The guide callout links to the guide's `publishing.html`, which the other agent created during this batch.
- Review fixes (2026-10-02): Japanese terms aligned with the guide (認証情報, インデックス, 一覧 for the preview catalog) and no half-width spaces around ASCII terms in Japanese text; architecture→guide links are root-absolute logical routes with `target="_top"`. Republished with `site publish --site architecture --config artifact-pages.yaml --fulltext` (dry-run, then publish: 145 files synced, 101 stale removed, 246 revalidation paths). Playwright re-check of all 12 pages at 400/1280 px in light and dark: no overflow, no console/page errors, all 20 same-origin links 200, all fragments present; reader navigation, guide link, and `?q=immutable leaf` (3 pages) re-verified.
- Run diagram, caption, text alternative, and proof list corrected to follow `site_publish.go`: (local storage only) `preflightLocalSourceBoundary` → site lock (skipped on dry-run) → `loadOriginRegistry` and source check → `buildSitePlan` (`indexer.Build` with the registered name/description, then listings and digest/metadata comparison) plus preview-catalog plan and retry-record read → dry-run stops → retry record → uploads in rank order → stale deletion → preview catalog reconciliation → invalidation → retry-record deletion → release. The lock bar now covers the build. Sampled list adds the T15 October 2 preview interruption/lock-recovery and scoped-credential runs.

## Second review fixes (2026-10-03, awaiting owner review)

- ja: レジストリ → サイトの登録情報 throughout prose, figures (登録情報：あり／なし in the race diagram labels), and meta description; "2つの接頭辞を一覧にして比べる" → "2つの接頭辞を一覧して比べる" (kept 接頭辞, used 15 times across the ja sites, instead of プレフィックス); 本物 → 実際の.
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
