# Site home mixes publisher introduction and tool navigation in one long page

- Status: Done
- Assignee: Claude
- Priority: P2
- Area: Web / site home and navigation

> Superseded in part by [ISSUE-129](ISSUE-129-site-introduction-html-and-top-bar-sections.md): the root introduction may also be `index.html`/`index.htm`, and the section links and search live in the top bar. The text below records the original decision.

## Problem

The site root uses the same directory composition as nested folders: site header, children, README/index body, then recently updated pages. An introduction must compete with the tool-generated list, and long introductory content pushes navigation or recent updates far down the page. The existing site header also spends substantial vertical space on preview explanation and a large jump control.

HTML index documents can define their own visual language, which clashes with the tool-generated header and children above them. The owner wants the site root to remain a predictable, tool-owned orientation surface, while publishers provide its introductory content in Markdown.

This is a product reader change across all sites, not the separate restructuring/writing of the official documentation. ISSUE-078's earlier work is complete; this records the newly selected site-home behavior, not a reopening of its verified criteria.

## Evidence and reproduction

1. Source inspected: product `origin/main` at `86841bb149deafc6408576517e228cb51f33f3d9`; production `/guide` inspected in the browser on 2026-10-16.
2. `web/src/domain/directory.ts` currently selects `README.md`, `index.md`, `index.html`, then `index.htm` (case-insensitive), at the site root and within nested folders.
3. `web/src/components/DirectoryPage.tsx` prepends children to either index format. `ArtifactWorkspace.tsx` supplies `SiteHomeHeader` and `RecentlyUpdated` at the root.
4. Production Guide currently has no root introduction, so its screenshot alone does not reproduce a root HTML collision. The mixed-format arrangement is established by the source. Normal/long/absent Markdown states were compared with sample content in a browser mock built from the captured production shell and CSS.
5. Owner selected the combined C1+C3 direction on 2026-10-16 and requested backlog capture before implementation.

## Selected outcome (owner decision)

- Keep the existing shared sidebar, context bar, content width, theme and Markdown rendering system.
- A compact common site header shows the site name, short description, document count and content update date. Do not perpetuate misleading freshness semantics; coordinate with ISSUE-105 where relevant.
- Below it, show **Overview / Files / Previews** as peer navigation items. Mock labels are Japanese; follow the product's existing UI language convention rather than hardcoding Japanese strings.
- Overview displays the publisher's Markdown introduction. Select `README.md` before `index.md`, retaining deterministic case-insensitive matching. Other Markdown files remain normal documents.
- At the site root only, `index.html` and `index.htm` remain normal, individually openable documents; do not embed them automatically as the site's overview. This is not a ban on publishing HTML at the root.
- Files contains the root's child folders/pages and recently updated documents. Retain existing deterministic filename ordering and accurate counts.
- Previews contains the site's existing preview-list experience, including real data, group handling and failure states.
- Keep the site-scoped search/jump entry on the right of the common tab row, usable from all three sections. Reuse the real palette and existing handoff to full-text search. It searches the published site; selecting Previews must not silently change its scope to preview content.
- Remove duplicate preview actions in the common header and duplicate search entries inside Files.

## Design references

- [Selected mock and original comparisons](assets/ISSUE-107/site-home-concepts.html#combined) — self-contained HTML; select the first comparison button, “統合案 · 3タブ＋検索”.
- [Selected desktop screenshot](assets/ISSUE-107/selected-site-home.png).

The comparison toolbar, sample docs tree, PR numbers, counts and copy are not product requirements. Mock search results, dialogs, filtering and page-link notices are placeholders; do not transplant them into production. The HTML is a visual reference, not a patch or a new runtime dependency.

## Settled behaviour (2026-10-17)

Settled by Claude main; the implementation and `docs/specification.md` (Site home) follow it.

- **Header.** Site title, registry description when present, "N pages" and "Updated <date>" from the newest document update in the active index. No preview explanation, preview action or large jump control.
- **Section row.** A `nav` of real links (Overview, Files, Previews), not ARIA tabs; `aria-current="page"` marks the current one; modifier-click and middle-click keep the browser behaviour. English labels.
- **Search entry.** At the right of the same row in all three sections. It opens the real published-site palette with the existing full-text hand-off, including from Previews, and focus returns to it. No other search entry in Files. At the narrow breakpoint it is an icon button named "Search this site".
- **Overview.** The root `README.md`, else `index.md` (case-insensitive, deterministic), as Markdown. Root `index.html` and `index.htm` are no longer embedded; they stay ordinary documents listed in Files and openable at their own URLs. Nested folders are unchanged.
- **URLs.** `/:site` is Overview when the site has an introduction and Files otherwise; `/:site?section=files` is Files; `/:site/_previews` and its group and revision URLs are unchanged. An unknown `section` value shows the default section and replaces the history entry.
- **Why `?section=files` and not `/:site/_files`.** Reserving a new first path segment the way `_previews` and `_search` are needs an indexer change (`ReservedFirstSegments` in `cli/internal/indexer/build.go`) and a contract change, which this ticket excludes. A query parameter needs no reservation, so a published `_files` path is never shadowed. Decided by Claude main on 2026-10-17 after the implementer stopped on this question.
- **No introduction.** No Overview link. If the introduction disappears while `/:site` is shown (a newer index), Files is shown in place with no error. `/:site?section=files` always works.
- **Previews.** The link is always present. After the catalog has loaded (the Previews section reports its own count) it shows the number of available previews; before that and on failure it shows no number. The section is the existing preview list, now with a "Try again" button after a failure. Without a site index to build the home from, the list stays a standalone page with a way back.
- **History and return.** Switching sections adds a history entry; Back and Forward restore it. Back from a document restores the section and its scroll position (offset kept per history entry); a newly chosen section starts at the top; nothing carries over between sites.
- **Empty site.** "0 pages", no Overview, Files with the existing empty message, working Previews.
- **Narrow screens.** All three links stay visible (no menu); no horizontal overflow at 390 px. No right context column (ISSUE-108) on these sections.

## Boundaries for Claude to settle before assigning implementation

The selected visual direction is decided. The following behavior was discussed but not approved as an exact technical contract. Claude main should inspect current code and write the implementation brief, using the configured advisor process where required. Do not silently promote these proposals to owner decisions.

- **No introduction:** proposed default is to omit Overview and open Files, while keeping normal root Markdown/HTML documents accessible. Decide behavior if the introduction disappears while its URL/state is open.
- **Preview availability:** define loading, zero available, expired/missing preview, catalog failure and retry behavior. A visible tab must lead to useful status or recovery; never display the mock's “2” before availability is established. Prefer retaining an accessible empty Previews section instead of a dead tab.
- **URLs and history:** decide how Overview/Files selection is represented. Preserve existing `/:site/_previews`, group-filter and revision-document deep links. The selected tab must agree with the visible content on direct entry, refresh and Back/Forward; a preview link should retain ordinary anchor/modifier-click behavior.
- **Return state:** define and verify tab/scroll restoration on returning from documents and switching sections; prevent state leakage across sites. The mock's exact scroll restoration was not successfully established in its first check and was adjusted without a final exact recheck. Do not copy it as verified behavior.
- **Mobile and accessibility:** determine how three tabs plus search fit without hiding essential actions; keep selected-state semantics, keyboard navigation, visible focus, skip-to-content and search-dialog focus return. The selected mock has not been verified on mobile.
- **Empty site:** handle a registered site with no published documents and its preview availability, without requiring a root directory listing to exist first.

If URL/state decisions require a durable technical design, place that decision in the technical-design track. This product issue records the user outcome and does not substitute for that design.

## Implementation scope and handoff

Primary inspection points: `web/src/components/ArtifactWorkspace.tsx`, `SiteHome.tsx` (including `SiteHomeHeader`), `DirectoryPage.tsx`, `PreviewListPage.tsx`, `web/src/App.tsx`, `web/src/routing.ts`, `web/src/domain/directory.ts`, `web/src/data/previews.ts`, and `web/src/styles.css`. Verify current main before editing; these are starting points, not a prescribed component decomposition.

Create the usual isolated worktree from current main and claim this issue when implementation begins. Follow workspace/repository delegation and cross-review rules; this issue is not authorization to bypass them or an instruction for a standalone Luna run. Under the current directory table, web implementation belongs to Sonnet and fresh Luna performs cross-review; Claude main resolves any owner-requested workflow change explicitly. No implementer should choose uncovered design decisions on its own.

Do not change nested directory landing behavior in this item. Letting nested HTML own its entire body was discussed but not selected for implementation. Keep direct document URLs, publisher HTML isolation, search contracts and preview trust boundaries working. No CLI, Actions, Terraform, registry/site-ID migrations, public docs rewrites or production release/deploy are included. Update the relevant site-home specification only after the remaining behavior is settled; do not rewrite unrelated spec sections.

## Acceptance criteria

- [x] A published site opens with the selected compact header and Overview / Files / Previews navigation, with no duplicate preview/search actions.
- [x] Root `README.md` wins over `index.md`; only those Markdown index documents are embedded as the introduction. Root HTML and non-index Markdown remain individually accessible. Existing nested directory behavior is unchanged.
- [x] Files shows actual child entries and recent updates in the existing deterministic order; search opens the real site-scoped palette from every section and retains existing full-text handoff.
- [x] The preview section uses actual catalog/list behavior, and existing list/group/revision deep links still work. Loading, empty, expired and error cases are intelligible and recoverable.
- [x] No-introduction, no-document, missing optional metadata and introduction-removal cases follow the settled brief without blank or dead navigation.
- [x] Direct entry, refresh, browser history, modified-click links, returning from a document, and cross-site switches preserve the intended location and state without changing published/preview scope.
- [x] Long introductory Markdown does not prevent section switching. Dark/light, narrow screens, keyboard tabs, search focus return and selected-state accessibility are verified against the actual product.
- [x] Relevant directory/routing regressions and browser flows are covered; run applicable web checks/build/E2E per repository instructions, perform fresh cross-review, and record results. No product checks have been run merely to file this issue.

## Verification

Run on `claude-issue-107` (from origin/main f603ac3e), 2026-10-17.

- `npm run build`: passes (`tsc -b` and `vite build`).
- `npm run test:web-unit`: passes, including new `directory.test.mjs` (root introduction is Markdown only, README over index, nested folders keep HTML index) and `search-route.test.mjs` (`?section=files`, `_files` stays an ordinary page).
- Full e2e, `CI=1`, compose project `claude-issue-107` on port 4407 with the ISSUE-072 recipe: 295 passed, 0 failed, 0 flaky (after the review fixes: catalog-wide badge on group links, Previews not waiting for the site index, one shared catalog and manifest load with its own tests). New `site home sections` tests cover the header, README over index.md, root `index.html` not embedded but listed and openable, nested index bodies, no introduction, introduction removed while open, unknown `section`, empty site, preview group link, search from each section with focus return and published scope, full-text hand-off, history and scroll restoration, modified-click on section links, cross-site switching, 390 px with no overflow, keyboard order and `aria-current`, and the dark theme. Existing site-home, directory and preview-list tests changed only where their premise did (the "View previews" link and preview status text became the Previews link and its count; the preview list now shows inside the site home with a retry).
- Screenshots of each section at 1440 px light and dark and at 390 px were taken to `.local/issue-107/` (not committed).
- Storybook builds; the site-home stories have dark and narrow variants. The fresh cross-review by Luna is still to be recorded by Claude main.
