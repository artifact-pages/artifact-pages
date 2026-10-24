# Contents level-3 entries are not indented under their level-2 entry

- Status: Done
- Assignee: Claude
- Priority: P3
- Area: Web / Contents (reader right column and narrow Contents panel)

## Problem

In the Contents rail, level-3 entries start at the same text inset as level-2 entries (ISSUE-114 chose to separate the levels by dot, weight and colour only). The owner finds that the children do not read as children: a short list such as 「パレットの検索」, 「本文検索」, 「対象と除外」, 「一致の規則」, 「結果」 looks like one run of siblings.

## Evidence and reproduction

1. Owner report, 2026-10-24 (production, `ja` site, dark theme): 「小要素はインデントが欲しい」 on the Contents of a page with h2 and h3 headings.
2. Source: `web/src/styles.css`, `.toc-rail .toc-link { padding: 3px 8px }` applies to `.toc-item-2` and `.toc-item-3` alike, so both texts start at the same x.

## Expected outcome

Level-3 entries start 12 px further right than level-2 entries. The rail, the level-2 dots and the small dot of a current level-3 entry stay where they are; only the level-3 text and its `--active`/`--hover` pill move right. This supersedes the "not by indentation" clause of ISSUE-114; everything else from ISSUE-114 stays.

## Acceptance criteria

- [x] In the Contents rail (right column at 1200 px and wider, and the narrow-screen Contents panel), a level-3 entry's text starts 12 px (±1 px) right of a level-2 entry's text; the current and hover pill of a level-3 entry starts 12 px right as well.
- [x] Rail position, level-2 dots, the current level-3 dot, progress colours, ellipsis on long titles and keyboard focus ring are unchanged; no horizontal overflow at the column's 256–312 px widths; light and dark both work.
- [x] The legacy `.toc-list` (non-rail) rendering, if still used anywhere, keeps its own level-3 indent.
- [x] The ISSUE-114 e2e test (or a new one beside it) measures the level-2 and level-3 text x positions so the indent cannot silently disappear.

Production check (2026-10-24, web 0.4.6, admin #31, App deploy run 40081524929: 80 create / 22 update, no deletes): on https://artifact-pages.dev/ja/05-reference/reader/search.html at 1440 px, dark, Claude measured the level-2 item and link at x 1155.6 / 1171.6 and the level-3 item and link at 1155.6 / 1183.6 (12 px indent, rail unchanged). Implemented in #202 (Sonnet; Luna review clean). Owner confirmed 2026-10-24.
