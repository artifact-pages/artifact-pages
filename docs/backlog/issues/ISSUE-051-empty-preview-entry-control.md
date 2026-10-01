# プレビュー0件でも「View previews」が押せる見た目で、反応せず意味も分からない

- Status: Open
- Priority: P3
- Area: Site home / Command palette

## Problem

プレビューがないサイトのホームで、「View previews →」が押せるリンクの見た目のまま表示され、押しても画面は変わらない。すぐ横に「There are no available previews for this site.」と出るため、押せるのか押せないのかが分かりにくい。また、「プレビュー」が何を指すのか（プルリクエストの公開前の確認用など）は、ホームでもパレットの Previews タブでも説明されない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide` を開く。「View previews →」と「There are no available previews for this site.」が並んで表示される。
2. 「View previews →」を押す。画面は変わらない。
3. ⌘K でパレットを開き、Previews タブを選ぶ。「There are no available previews for this site.」とだけ表示され、プレビューの説明はない。

## Expected outcome

プレビューがないとき、入口が押せない状態だと見た目で分かる。プレビューが何のためのものかを、入口で短く知ることができる。

## Acceptance criteria

- [ ] プレビュー0件のとき、入口が押せる見た目のまま無反応にならない（押せない見た目にする、または押したときの結果が分かる）。
- [ ] ホームとパレットの Previews タブで、プレビューの意味が短く分かる。
- [ ] プレビューがあるサイトでは、これまでどおり一覧へ進める。

## Related issues and scope

- ISSUE-046（完了記録は Git 履歴に保存）で、プレビュー0件のときに空画面へ移動しないようにした。本件は、その後に残った入口の見た目と説明を扱う。
