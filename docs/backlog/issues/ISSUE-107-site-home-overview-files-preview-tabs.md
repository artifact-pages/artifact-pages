# Site home mixes publisher introduction and tool navigation in one long page

- Status: Open
- Priority: P2
- Area: Web / site home and navigation

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

- [ ] A published site opens with the selected compact header and Overview / Files / Previews navigation, with no duplicate preview/search actions.
- [ ] Root `README.md` wins over `index.md`; only those Markdown index documents are embedded as the introduction. Root HTML and non-index Markdown remain individually accessible. Existing nested directory behavior is unchanged.
- [ ] Files shows actual child entries and recent updates in the existing deterministic order; search opens the real site-scoped palette from every section and retains existing full-text handoff.
- [ ] The preview section uses actual catalog/list behavior, and existing list/group/revision deep links still work. Loading, empty, expired and error cases are intelligible and recoverable.
- [ ] No-introduction, no-document, missing optional metadata and introduction-removal cases follow the settled brief without blank or dead navigation.
- [ ] Direct entry, refresh, browser history, modified-click links, returning from a document, and cross-site switches preserve the intended location and state without changing published/preview scope.
- [ ] Long introductory Markdown does not prevent section switching. Dark/light, narrow screens, keyboard tabs, search focus return and selected-state accessibility are verified against the actual product.
- [ ] Relevant directory/routing regressions and browser flows are covered; run applicable web checks/build/E2E per repository instructions, perform fresh cross-review, and record results. No product checks have been run merely to file this issue.
