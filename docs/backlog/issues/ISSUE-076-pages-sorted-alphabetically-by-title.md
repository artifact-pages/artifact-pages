# Navigation, site home and breadcrumb menus sort pages alphabetically by title, losing the author's reading order

- Status: Blocked
- Priority: P1
- Area: Reader ordering (`web/src/domain/tree.ts`, `ArtifactBreadcrumbs.tsx`, `SiteHome.tsx`); site index (`cli/internal/indexer`, Codex-owned)

## Blocker

Blocked on [TD19](../technical-design/TD19-navigation-metadata-in-the-site-index.md): the index has no order field, and the design for author-defined order is undecided. Unblock when TD19 is decided; the index change is CLI-side (Codex-owned, `cli/internal/indexer`) and the reader change is web-side (Claude-owned). Announce the cross-directory split in `STATUS.md` before either side starts.

## Problem

Pages are always ordered by `title.localeCompare`, so an author cannot place an introduction first or keep a numbered sequence. The "What is Git Artifact Pages?" page, the logical first page, is last in the Guide's `en` folder. Japanese titles are ordered with the default locale collator, so the Japanese order is arbitrary and differs from the English one.

## Evidence and reproduction

From the 2026-10-11 dogfooding of `https://artifact-pages.dev`, confirmed in code on this tree.

1. Open `/guide` and expand `en`. Order: Access and trust, Configuration, Getting started, Pinning and upgrading versions, Publishing, Reading, What is Git Artifact Pages?. The introduction is last and Getting started is third.
2. Open `/architecture`. The pages carry their own in-page tabs "01 Overview" to "06 Trust model", but the sidebar shows Architecture overview, Previews, Publishing model, Search and indexes, Storage layout, Trust model.
3. Expand `ja`. The order (Git Artifact Pagesとは, サイトの公開, バージョンの固定と更新, はじめる, 信頼とアクセス制御, 設定ファイル, 読者の体験) bears no relation to the English order.
4. Sources: `sortTree` sorts `node.artifacts` by `title.localeCompare` (`web/src/domain/tree.ts:63-68`); the breadcrumb menu uses `compareArtifacts` (title, then path; `ArtifactBreadcrumbs.tsx:317-319`). The site picker also sorts sites by title (`SitePicker.tsx:27`; site order is covered by [ISSUE-078](ISSUE-078-landing-page-has-no-orientation.md)). The same order appears in the site home Browse list and in sibling menus; full-text results are path-ordered (ISSUE-077). `ArtifactIndexEntry` has no order field (`web/src/domain/index.ts:58-69`; Go `ArtifactIndexEntry` at `cli/internal/indexer/build.go:108-119`).
5. `localeCompare` is called without a locale argument, so it uses the browser default locale (confirmed in code; the specific Japanese order observed is from the live site).

Hypothesis, not tested: sorting by filename instead of title would already fix the Architecture case if its filenames carry the 01-06 prefix; this has not been checked against the source files.

## Expected outcome

A site author controls the order of pages and folders, the reader honors it everywhere pages are listed, and pages without explicit order keep a deterministic fallback.

## Acceptance criteria

- [ ] TD19 is decided and records the ordering mechanism and the fallback.
- [ ] The artifact index carries the order information the decision requires, as an optional field (additive; reader ignores unknown fields per TD2).
- [ ] The sidebar tree, site home Browse list, breadcrumb sibling menus, directory pages (ISSUE-075) and any prev/next navigation (ISSUE-082) use one shared comparator.
- [ ] Pages without an explicit order sort after ordered pages with a deterministic fallback that uses the page's own language collator for titles (or filename order, if TD19 so decides).
- [ ] A fixture with an introduction page and a numbered sequence shows them in author order in all listings; a unit test covers the comparator with ordered, unordered and mixed Japanese and English titles.
- [ ] Specification updated.
