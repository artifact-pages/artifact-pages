# パンくずのフォルダと文書のメニューが同じ内容に見える

- Status: Open
- Priority: P3
- Area: Artifact header breadcrumb

## Problem

文書を開いたときの上部のパンくず「en ⌄ / Reading ⌄」で、どちらのメニューも同じフォルダの文書一覧と「Show in sidebar」を表示する。2つのメニューの違いが分からず、どちらを使えばよいか判断できない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開く。
2. 「en ⌄」を押す。見出し `en`（2 artifacts）の下に Reading（Current）と What is Git Artifact Pages?、「Show in sidebar」が出る。
3. Esc で閉じ、「Reading ⌄」を押す。見出しが `en/reading.html` になるだけで、同じ2件と「Show in sidebar」が出る。

未確認の観測：手順3で、Esc で閉じた直後の最初のクリックではメニューが開かず、2回目のクリックで開いた。1回だけの観測で、再現条件は確かめていない。

## Expected outcome

フォルダのメニューと文書のメニューが、それぞれ何をするためのものかが分かる。必要がなければ、片方にまとまっている。

## Acceptance criteria

- [ ] フォルダ部分と文書部分のメニューの役割の違いが、表示内容から分かる（または1つにまとまっている）。
- [ ] 一方のメニューを Esc で閉じた直後でも、もう一方を1回のクリックで開ける。
- [ ] キーボードでも、同じメニューを開いて項目を選べる。
