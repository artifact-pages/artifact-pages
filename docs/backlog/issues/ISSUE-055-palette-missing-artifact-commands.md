# 上部の文書操作の一部がパレットのコマンドにない

- Status: Open
- Priority: P3
- Area: Command palette commands

## Problem

文書の上部には Pin と Details の操作があるが、パレットで `>` と入力したコマンド一覧には、ピン留めと Details を開く操作がない（Toggle contents、リンクのコピー、元ファイルを開く、などはある）。キーボード中心の利用者は、ピン留めや詳細の表示だけ、マウスで上部のボタンを押す必要がある。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開き、⌘K でパレットを開いて `>` と入力する。
2. 表示されるコマンド：Toggle sidebar、Toggle contents、Go to site home、Use light theme、Use dark theme、Use system theme、Copy artifact link、Open raw artifact。
3. ピン留め（Pin／Unpin）と Details の表示は一覧にない。

## Expected outcome

文書に対して上部のボタンでできる主な操作を、パレットのコマンドからも実行できる。

## Acceptance criteria

- [ ] 文書を開いているとき、パレットのコマンドからピン留めとピン留めの解除ができる。
- [ ] パレットのコマンドから Details を開閉できる。
- [ ] 文書を開いていない画面では、これらのコマンドが実行できない状態で表示されない。

## Related issues and scope

- ISSUE-048 はパレットの候補の見せ方を扱う。本件はコマンドの種類の不足だけを扱い、候補の並べ方は変えない。
