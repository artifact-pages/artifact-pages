# 検索欄の ⌘K 表示が、その欄へのショートカットに見える

- Status: Done
- Priority: P2
- Area: Site home search / Sidebar filter

## Problem

サイトホームの検索欄とサイドバーの「Filter navigation」の両方に ⌘K の表示が付いている。そのため、⌘K でその欄に入力できるように見えるが、実際には ⌘K でどちらの欄でもなくコマンドパレットが開く。検索の入口が3つあり、それぞれの違いが画面から分かりにくい。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide` を開く。ホームの検索欄の右端に `⌘ K / Ctrl K`、サイドバーの欄の右端に `⌘K` が表示されている。
2. ⌘K を押す。ホームの検索欄でもサイドバーの欄でもなく、コマンドパレットが開く。
3. ホーム検索の下には「Typing filters artifacts in this site. ⌘K / Ctrl K opens full search.」と小さく表示されるが、欄の中の表示とは結び付きにくい。

## Expected outcome

各検索欄の表示から、⌘K を押したときに何が開くのかを正しく予測できる。3つの入口（ホーム検索、サイドバーの絞り込み、パレット）の違いが分かる。

## Acceptance criteria

- [x] ⌘K の表示が、実際に ⌘K で起きること（パレットが開く）と矛盾しない。
- [x] ホーム検索とサイドバーの絞り込みが、それぞれ何を絞り込む欄なのかが画面から分かる。
- [x] 通常幅と狭い幅で、表示が崩れたり重なったりしない。

## Related issues and scope

- ISSUE-039（完了記録は Git 履歴に保存）は検索入口の役割の分かりやすさを扱った。本件は欄の中のショートカット表示と実際の動作の食い違いを扱う。

## Verification (2026-10-01)

- Site home: the filter field no longer shows a ⌘K badge or declares `aria-keyshortcuts`. A separate "Full search ⌘ K" button (accessible name "Full search in <site>", `aria-keyshortcuts` on the button) beside the field opens the palette and receives focus back when the palette closes; on narrow screens it shows "Full search" without the kbd. The help text now says the field filters by title or path; with several matches it says "Press ↓ to choose a match, then Enter to open it." (Tab reaches the Full search button before the results.)
- Sidebar: the existing palette trigger inside the filter now shows a visible "Search" label and a bordered chip style so it reads as its own control; the narrow-screen "Search pages" hint is unchanged.
- Other remaining ⌘K hints (site picker trigger, collapsed rail) sit on controls that open the palette.
- Updated e2e tests cover the desktop and mobile affordances, the button opening the palette and restoring focus, and keyboard paths. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 83/83 (earlier runs each had one or two preview-navigation tests fail and pass on rerun, unrelated to this change). Manual check in Chrome at 606px.
- A Sonnet subagent review found no blockers; its should-fix item (focus restore in Safari and Firefox) and nits (indentation, redundant width) were applied.
