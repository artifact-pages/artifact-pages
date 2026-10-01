# 目次パネルの「Keep reading」の意味が分からない

- Status: Open
- Priority: P3
- Area: Contents / Details panel

## Problem

Contents と Details のパネルの右上にある「Keep reading」が、何をするボタンなのかを名前から読み取れない。また、Contents で見出しを選ぶとパネルが閉じるため、続けて別の見出しへ移りたいときは、もう一度パネルを開く必要がある。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開き、上部の Contents を押す。パネルの右上に「Keep reading」が表示される。
2. 目次の項目（例：Keyboard shortcuts）を押す。パネルが閉じ、文書がその見出しへ移動する。
3. Details を開いた場合も、右上に同じ「Keep reading」が表示される。

## Expected outcome

パネルを閉じて読み続ける操作だと、ボタンの名前や見た目から分かる。目次を選んだあとにパネルが閉じることが予測できる、または続けて使える。

## Acceptance criteria

- [ ] 「Keep reading」に当たる操作の役割が、名前または見た目から分かる。
- [ ] 目次の項目を選んだあとのパネルの動き（閉じる・開いたまま）が、利用者の予測と合う。
- [ ] 通常幅と狭い幅で、本文が読める状態へ戻れる。

## Related issues and scope

- ISSUE-047（完了記録は Git 履歴に保存）で、パネルを開いたまま読むと本文が隠れる問題に対して、読み続ける操作を追加した。本件はその操作の名前の分かりにくさを扱う。
