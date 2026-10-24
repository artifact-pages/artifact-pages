# Browse tree child pages start left of their folder's name

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Web / sidebar, Browse tree

## Problem

In the sidebar Browse tree, a page inside an expanded folder starts its title further left than the folder's own name. The folder row reserves a chevron slot before its name; a page row has no chevron and starts its title right after the branch guide. The hierarchy then reads backwards: the child looks less indented than its parent.

## Evidence and reproduction

1. Owner report, 2026-10-23 (production web 0.4.2, `ja` site, dark theme): under 「体験と機能」 the pages 「資料を公開・レビューする」 etc. start left of 「体験と機能」; the same under 「インフラを構築する」.
2. Source (`branch-guides`, the style the sidebar uses): a folder row is a 4 px margin + 22 px chevron toggle + 2 px link padding, so its name starts at 28 px; `.tree-children-branch-guides` indents children by 14 px and a page row pads 8 px, so a child page's title starts at 22 px, 6 px left of the parent's name. Every depth repeats this. The `quiet` style has the same mismatch (`10 + depth * 14` against `5 + depth * 14 + 24`).
3. Owner report, 2026-10-23 (production web 0.4.3, `ja` site): the horizontal connectors are drawn left of the vertical guide (x 12 to 26 with the guide at 26) instead of running from the guide toward the row. Cause: the connector rule in `web/src/styles.css` used `left: -14px; width: 14px`.

## Expected outcome

At every depth, a child's title (page or folder) starts to the right of its parent folder's name, and the titles of sibling pages and sibling folders start at the same x position: a page row takes the space of the chevron slot a folder row has. Root-level pages align with root-level folder names the same way.

## Acceptance criteria

- [x] In the Browse tree (`branch-guides`), for depths 0 to 3, a child title starts at least 8 px right of its parent folder's name, and sibling page and folder titles share one start x (±1 px).
- [x] The branch guide lines and their horizontal connectors meet the rows they belong to: each connector starts at the guide and ends 8 px before the row's title (page) or chevron (folder); hover, active and focus backgrounds, the row actions menu, the count, the MD tag and ellipsis on long titles keep working at the 260–320 px sidebar widths and in the narrow-layout drawer.
- [x] The `quiet` style follows the same rule; `path-list` and the flat lists (Pinned, filter results, Recent) are unchanged.
- [x] Regression coverage measures the title positions (e2e or a layout test) so a later change cannot reverse the hierarchy again.

Verification note (Claude main, 2026-10-23): the sidebar never renders `quiet`, so that criterion is checked by geometry in `ArtifactTree.tsx`: folder name at 5 + 14·depth + 22 + 2 px (linked) or 11 + 14·depth + 11 + 7 px (label-only), page title at 29 + 14·depth px. Luna review of PR #197: no findings.

Production check (2026-10-24, web 0.4.4, admin #29, App deploy run 39961746380): on the `ja` site with 「体験と機能」, 「導入する」 and 「インフラを構築する」 expanded, Claude measured all 12 connectors: each starts at its guide and ends 8 px before the title or chevron (e.g. 「資料を公開・レビューする」: guide 26, connector 26–46, title 54). Connector fix #198, Luna review clean. Owner confirmed the production view on 2026-10-24.
