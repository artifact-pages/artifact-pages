# DOC-08 — Architecture: overview and site registration

- Status: In progress
- Site: `architecture`
- Page: `ja/overview.html`, `en/overview.html`
- Audience: Readers who want to understand how the system works
- Depends on: DOC-01

## Purpose

Explain the system shape: the stable application plane (`/index.html`, `/assets/*`), the changing content plane (`/_indexes/*`, `/_artifacts/*`), static delivery, and Git as the source of truth. This ticket also creates and registers the `architecture` site.

## Scope

- Create `docs/public/sites/architecture/{ja,en,assets}` using the shared assets from DOC-01.
- Register `architecture` with the name and description from the track README; publish.
- The two planes, logical routes vs storage paths, and why there is no request-time server.
- Links from the guide overview to this page.

## Out of scope

- Storage details (DOC-09) and publish mechanics (DOC-10).

## Primary sources

- [Thesis](../../thesis.md), [Specification §1–§5, §21 invariants](../../specification.md)

## Acceptance criteria

- [x] `ja/overview.html` and `en/overview.html` exist with matching structure, localized H1 and `<title>`, and a working language switch.
- [x] Every command, flag, path, and behavior matches the linked primary sources and current CLI help.
- [x] Renders correctly in light and dark themes (including inside the reader app) and at ~400px width without horizontal scrolling.
- [x] Published locally with `site publish --dry-run` then `site publish`, and opened in the local reader.
- [ ] The owner reviewed and approved the page.

## Verification (2026-10-02, drafted in the batch with DOC-08–DOC-13; awaiting independent and owner review)

- Published locally: `./artifact-pages site publish --site architecture --config artifact-pages.yaml --fulltext --dry-run` (146 planned creates), then the same command without `--dry-run` (`PUBLISHED`). `meta.json` advertises `fullTextUrl`.
- Playwright (throwaway script outside the repo) opened every architecture page in `ja` and `en` directly under `/_artifacts/architecture/…` at 400 px and 1280 px in light and dark: no page-level horizontal overflow, no page or console errors, one localized H1 and `<title>` per page, `lang` set, the site page list marks the current page, every same-origin link (including the language switch, previous/next, cross-links, and links to `/guide/<lang>/…`) returns 200, and every in-site `#fragment` exists. Wide diagrams scroll inside their own frame and only then become keyboard-focusable.
- In the reader at http://localhost:4179: the site picker lists Architecture; Next moved the app to `/architecture/en/storage-layout.html`; the language switch moved it to `/architecture/ja/storage-layout.html`; a guide link moved it to `/guide/en/access-and-trust.html`; `?q=immutable leaf` listed 3 pages and highlighted the terms in the open page; at 400 px the framed page has no horizontal overflow.
- Created `docs/public/sites/architecture/{ja,en,assets}` with the shared assets, added `architecture` to `artifact-pages.yaml` with the README's name and description, and ran `registry register --dry-run` then `registry register` (registry projection updated; `guide` kept).
- Facts checked against the thesis, specification §1–§5, §13, §15, §16, §20–§21, `docker/nginx/default.conf`, and T15 (sampled Cloudflare observations; no live AWS proof).
- The guide overview (`what-is-git-artifact-pages.html`, ja/en) now links this page with a root-absolute `/architecture/<lang>/overview.html` route; the earlier "not done" note is resolved.
- Review fixes (2026-10-02): Japanese terms aligned with the guide (認証情報, インデックス, 一覧 for the preview catalog) and no half-width spaces around ASCII terms in Japanese text; architecture→guide links are root-absolute logical routes with `target="_top"`. Republished with `site publish --site architecture --config artifact-pages.yaml --fulltext` (dry-run, then publish: 145 files synced, 101 stale removed, 246 revalidation paths). Playwright re-check of all 12 pages at 400/1280 px in light and dark: no overflow, no console/page errors, all 20 same-origin links 200, all fragments present; reader navigation, guide link, and `?q=immutable leaf` (3 pages) re-verified.
- Overview fixes: 要点 reads 正本はGitにあります; the section heading is Gitが正本、Webサイトはそこから作る投影; Where to go next now lists Trust model (06); proof chips updated for the October 2 Cloudflare samples.
- Narrative revision (2026-10-02, awaiting owner review): the 要点 / Short answer now states that each site publishes from its own repository separately from the others into one shared static projection, and one reader app presents every site the same way. New section 公開はサイトごとに、読む体験は共通に / Independent publishing, shared experience (`#independent`) explains that no step builds all sites, who writes what and when (`app deploy`, `registry register`, `site publish` under the per-site lock), and that the shared projection layout plus `sites.json`/`meta.json` let one app give every site the same picker, tree, palette, page text search (where published), pins and recents, reader, Contents/Details, and links to previews and Git, with search scoped to the open site. The Git-source section says artifacts are made and reviewed in their repository and never edited by Artifact Pages; meta descriptions updated. The proof section already lists cross-site concurrent publishes on a real provider as not yet proven, so the independence claims are stated as the design contract. Other architecture pages were reviewed and do not contradict this framing. Republished with `site publish --site architecture --config artifact-pages.yaml --fulltext` (dry-run first; synced 42 files, removed 35 stale files). Playwright re-check of the overview ja/en at 400/1280 px light/dark: no overflow, no errors, links resolve.

## Second review fixes (2026-10-03, awaiting owner review)

- ja: 本物の404 → 実際の404応答 (figure and table); "移動の基本にはしません" → "画面移動のURLには使いません"; 本物のCloudFront → 実際のCloudFront; page list and card label プレビュー → プレビューの仕組み (matches the page title; en Previews already matched).
- Verification (second round): `npm run docs:sync-assets` and `npm run docs:check-assets` pass; CLI rebuilt; `site publish --site guide|architecture --config artifact-pages.yaml --fulltext` dry-run then publish, and a dry-run right after each publish reports `+ 0 create ~ 0 update - 0 remove` (no search-blob churn). Playwright (`r2/check.mjs`, served from `.local/public-site/storage` by a throwaway static server because the local nginx container on :4179 was returning 500 with a Docker I/O error): all 22 pages, ja/en, light/dark, 400/1280 px (88 runs): no page-level overflow, one H1, no heading-level skips, no duplicate ids, no SVG text outside its viewBox, every scrollable figure frame focusable, no console or page errors; all 91 distinct same-origin links return 200, anchors exist, cross-site links use `target="_top"`. The overview's reader-demo title is now a styled `div` instead of an H3 (it caused an H1→H3 skip). Scene-3 animation re-sampled (`r2/anim.mjs`): order checkout→sre→billing, publishes out of sync with ≥1.7 s between starts, no flicker returning from scene 4, staggered entry from scene 2, reduced motion static.
