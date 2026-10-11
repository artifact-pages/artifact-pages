# Navigation, site home and breadcrumb menus sort pages alphabetically by title, not like a file browser

- Status: Done
- Assignee: Claude
- Priority: P1
- Area: Reader ordering (`web/src/domain/tree.ts`, `ArtifactBreadcrumbs.tsx`, `SiteHome.tsx`, `directory.ts`); web only

## Decision

[TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md) is decided (owner, 2026-10-11): follow GitHub's repository file browser. Listings show folders first, then files, each sorted by filename. There is no order field, no front-matter key and no nav file, so the index and the CLI do not change. Authors who want a specific order name their files (`01-intro.html`); the product adds no prefix-stripping rule.

## Problem

Pages are always ordered by `title.localeCompare`, so an author cannot place an introduction first or keep a numbered sequence. The "What is Git Artifact Pages?" page, the logical first page, is last in the Guide's `en` folder. Japanese titles are ordered with the default locale collator, so the Japanese order is arbitrary and differs from the English one.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, confirmed in code on this tree.

1. Open `/guide` and expand `en`. Order: Access and trust, Configuration, Getting started, Pinning and upgrading versions, Publishing, Reading, What is Git Artifact Pages?. The introduction is last and Getting started is third.
2. Open `/architecture`. The pages carry their own in-page tabs "01 Overview" to "06 Trust model", but the sidebar shows Architecture overview, Previews, Publishing model, Search and indexes, Storage layout, Trust model.
3. Expand `ja`. The order (Git Artifact Pagesとは, サイトの公開, バージョンの固定と更新, はじめる, 信頼とアクセス制御, 設定ファイル, 読者の体験) bears no relation to the English order.
4. Sources: `sortTree` sorts `node.artifacts` by `title.localeCompare` (`web/src/domain/tree.ts:63-68`); the breadcrumb menu uses `compareArtifacts` (title, then path; `ArtifactBreadcrumbs.tsx:317-319`). The site picker also sorts sites by title (`SitePicker.tsx:27`; site order is covered by [ISSUE-078](ISSUE-078-landing-page-has-no-orientation.md)). The same order appears in the site home Browse list and in sibling menus; full-text results are path-ordered (ISSUE-077). `ArtifactIndexEntry` has no order field (`web/src/domain/index.ts:58-69`; Go `ArtifactIndexEntry` at `cli/internal/indexer/build.go:108-119`).
5. `localeCompare` is called without a locale argument, so it uses the browser default locale (confirmed in code; the specific Japanese order observed is from the live site).

The docs repository's files carry no numeric prefixes (for example `sites/architecture/en/overview.html`), so the docs sites will list in plain filename order unless that repository renames its files. Whether to rename is an owner decision tracked separately.

## Expected outcome

Every listing orders folders before files and sorts each group by filename, so authors control order by naming files, and the order is the same everywhere pages are listed.

## Resolution

One shared comparator, `web/src/domain/listing-order.ts`, is used by the sidebar tree (`tree.ts`), the Browse list on the site home (`ArtifactTree.tsx`), breadcrumb sibling menus (`ArtifactBreadcrumbs.tsx`) and directory pages (`directory.ts`). Paths compare segment by segment; at the first differing segment a folder sorts before a file, and names compare by lower-cased Unicode code points, then by the exact name, then by id. This approximates GitHub's file browser (case-insensitive, no natural number sorting; not guaranteed identical in every edge case) and uses no `Intl.Collator`, so the result does not depend on the browser locale. Consequences, documented in the specification: `10-x` sorts before `2-x` (use fixed-width prefixes), and Japanese names sort by code point (hiragana, katakana, then kanji), not by reading. The site picker, full-text results and landing-page site order are unchanged (ISSUE-078 owns the site order).

## Acceptance criteria

- [x] One shared comparator orders folders first, then files, each by filename (the last path segment), deterministically and independent of the browser locale (a fixed, documented comparison; numeric prefixes such as `01-` sort before `10-`).
- [x] The sidebar tree, site home Browse list, breadcrumb sibling menus and directory pages use that comparator. Full-text results keep their own ranking.
- [x] A fixture with a numbered sequence and folders shows author order (folders first) in all listings; unit tests cover the comparator with prefixed, unprefixed and mixed Japanese and English filenames.
- [x] Specification updated (directory page and tree ordering sentences).
