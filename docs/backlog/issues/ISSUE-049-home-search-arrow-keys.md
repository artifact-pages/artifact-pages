# ホーム検索の結果へ ↓ キーで移れない

- Status: Done
- Priority: P2
- Area: Site home search

## Problem

サイトホームの検索欄で絞り込んだあと、↓ キーを押しても結果に移らず、Enter も何もしない。結果へ進むには、欄の下の案内どおり Tab を押す必要がある。コマンドパレットでは ↓ と Enter で候補を選んで開け、サイドバーの「Filter navigation」では Enter で先頭の候補が開く。見た目の似た入口で操作が食い違い、ホーム検索で手が止まる。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide` を開き、検索欄「Filter artifacts in Guide」に `read` と入力する（2件に絞り込まれる）。
2. ↓ キーを押す。フォーカスは欄に残り、結果は選択されない。
3. Enter を押す。何も起きない。
4. Tab を押すと先頭の結果にフォーカスが移り、Enter で開ける。
5. 比較：パレットでは ↓ と Enter で候補を選んで開ける。サイドバーの「Filter navigation」に `what` と入力して Enter を押すと、先頭の候補が開く（↓ キーは処理されない。レビュー時の記録では ↓ と Enter で開いたと書いたが、実際に開いたのは Enter による先頭の候補だった）。

## Expected outcome

ホーム検索でも、パレットと同じ感覚で ↓ キーと Enter で結果を選んで開ける。少なくとも、↓ を押したときに何が起きるかを予測できる。

## Acceptance criteria

- [x] ホーム検索で絞り込んだあと、↓ キーで結果を選択し、Enter で開ける（または、そうしない理由が画面上で分かる）。
- [x] Tab による移動と、マウスでのクリックは引き続き使える。
- [x] サイドバーの絞り込みとパレットの既存のキーボード操作を変えない。
- [x] 修飾キー付きの矢印キー（Shift+↓ による文字の選択など）と、ほかの一覧（Recently updated）の先頭での ↑ は、ブラウザの通常の動きを妨げない。

## Related issues and scope

- ISSUE-039（完了記録は Git 履歴に保存）でホーム検索の Enter 操作を整えた。本件はその後に残った ↓ キーの差を扱う。

## Verification (2026-10-01)

- `web/src/components/SiteHome.tsx`: ↓ in the site-home search field focuses the first match; ↓/↑/Home/End move between rows; ↑ on the first match returns to the field with the query kept. Modified arrow keys (for example Shift+↓ to extend a text selection) are left to the browser, and ↑ on the first row of Recently updated keeps its default behavior. Enter in the field still opens only a sole match (ISSUE-039's decision). The help text now reads "Press ↓ or Tab to choose a match, then Enter to open it."
- New e2e test "site home search moves through matches with arrow keys like the other search entries" covers ↓/↑/Home/End, the return to the field, opening the second match with Enter, and ↓ with no matches. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed. `node scripts/run-e2e.mjs` passed 83/83; two other runs each had one different preview-navigation test fail and pass on rerun, unrelated to this change.
- Manual check in Chrome at 606px: `read` then ↓, ↓, Enter opened `en/reading.html`.
- A subagent review found no blockers; its should-fix items (comment accuracy, ↑ on the first Recently updated row) and nits (modifier keys, `event.target`, Home/End test coverage) were applied.
