# DOC-11 — Architecture: previews

- Status: In progress
- Site: `architecture`
- Page: `ja/previews.html`, `en/previews.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-10

## Purpose

Explain the pull-request preview model: preview records and revision manifests, routes, retention, and stale-reference cleanup.

## Scope

- How a preview is created, found, and cleaned up.

## Out of scope

- Publisher-facing how-to (DOC-04).

## Primary sources

- [Specification §19 pre-publish preview contract](../../specification.md), [Preview decisions](../../architecture/preview-decisions.md), [T1](../technical-design/T1-preview-record-contract.md), [T3](../technical-design/T3-provider-retention.md)

## Acceptance criteria

- [x] `ja/previews.html` and `en/previews.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-02, drafted in the batch with DOC-08–DOC-13; awaiting independent and owner review)

- Published locally: `./artifact-pages site publish --site architecture --config artifact-pages.yaml --fulltext --dry-run` (146 planned creates), then the same command without `--dry-run` (`PUBLISHED`). `meta.json` advertises `fullTextUrl`.
- Playwright (throwaway script outside the repo) opened every architecture page in `ja` and `en` directly under `/_artifacts/architecture/…` at 400 px and 1280 px in light and dark: no page-level horizontal overflow, no page or console errors, one localized H1 and `<title>` per page, `lang` set, the site page list marks the current page, every same-origin link (including the language switch, previous/next, cross-links, and links to `/guide/<lang>/…`) returns 200, and every in-site `#fragment` exists. Wide diagrams scroll inside their own frame and only then become keyboard-focusable.
- In the reader at http://localhost:4179: the site picker lists Architecture; Next moved the app to `/architecture/en/storage-layout.html`; the language switch moved it to `/architecture/ja/storage-layout.html`; a guide link moved it to `/guide/en/access-and-trust.html`; `?q=immutable leaf` listed 3 pages and highlighted the terms in the open page; at 400 px the framed page has no horizontal overflow.
- Facts checked against specification §19, the preview decision register, T1, T3, TD3, `artifact-pages preview publish --help`, `fixtures/storage/_previews/`, and T4/T5/T6/T8/T15/T17.
- Review fixes (2026-10-02): Japanese terms aligned with the guide (認証情報, インデックス, 一覧 for the preview catalog) and no half-width spaces around ASCII terms in Japanese text; architecture→guide links are root-absolute logical routes with `target="_top"`. Republished with `site publish --site architecture --config artifact-pages.yaml --fulltext` (dry-run, then publish: 145 files synced, 101 stale removed, 246 revalidation paths). Playwright re-check of all 12 pages at 400/1280 px in light and dark: no overflow, no console/page errors, all 20 same-origin links 200, all fragments present; reader navigation, guide link, and `?q=immutable leaf` (3 pages) re-verified.
- Proof list updated: T17 (local preview retirement E2E) moved to proven locally; the two-new-head CLI race, interrupted-upload lock recovery, lost-owner rejection, and simulated-deletion main-publish cleanup (T15, October 2) moved to sampled. Still open: actual lifecycle deletion timing, real GitHub PR/CI publication, AWS cleanup.

## Second review fixes (2026-10-03, awaiting owner review)

- ja: the preview catalog is プレビューの一覧（`catalog.json`）on first mention and プレビューの一覧 everywhere else, including the figure `<desc>` (no more サイトの一覧 or bare 一覧); デプロイ済みのレジストリ → サイトの登録情報; 本物の404 → 実際の404応答; page list label → プレビューの仕組み.
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
