# 検索入口ごとの操作差が分かりにくく、ホーム検索で Enter が止まる

- Status: Done
- Priority: P2
- Area: Site home / Sidebar filter / Command palette

## Problem

ホームとサイドバーは似た検索入力欄と ⌘K 表示を持つが、Enter の結果が異なる。ホームでは1件に絞っても文書を開けず、キーボードで検索した利用者の操作が止まる。ツリー絞り込み・一覧検索・パレット検索の役割も、入口の見た目だけでは区別しづらい。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザ、Guide の4文書で確認。レビュー F02・F07 を同じ検索入口の問題として統合。

1. `http://127.0.0.1:4179/guide` の Search artifacts in Guide に「読者」を入力する。
2. 1 match になってから Enter を押しても、ホームのままで文書は開かない。
3. サイドバーの Filter navigation に同じ文字を入力して Enter を押すと文書が開く。パレットの選択結果も Enter で開く。
4. サイドバーの入力欄はツリーを絞り、隣の ⌘K ボタンは別途パレットを開く。

ローカル補足証拠: `.local/ux-review-2026-10-01/home-search-enter.jpg`（未追跡）。実機IMEの変換確定は未検証。

## Expected outcome

各検索入口の目的と実行方法を予測でき、ホームでもキーボードだけで検索した文書へ進める。入口を統合することは必須ではない。

## Acceptance criteria

- [x] ホームで1件に絞った文書をキーボードで選択・実行でき、実行方法が画面から分かる。
- [x] 一覧／ツリーの絞り込みとパレットを開く操作の違いがラベルや操作表示で分かる。
- [x] 複数件・ゼロ件でも選択対象と実行可否が明確で、既存のサイドバー・パレットの操作を損なわない。

## Verification

2026-10-01: `npm run build` passed. Four focused Playwright cases for site-home search and desktop/mobile search affordances passed against port 4174, including unique/multiple/zero results, Escape, and synthetic IME composition. Codex in-app browser at port 4179 reproduced the original failure and verified Enter opens `/guide/ja/reading.html` for the unique 「読者」 match after the fix. The final wording-only follow-up shows both ⌘K and Ctrl+K and passed rendered desktop/mobile assertions; it was not rechecked in the in-app browser after its binding disappeared. Real-device IME remains unverified. A separate gpt-6-luna max reviewer approved the behavior, then rechecked the corrected shortcut hints with no remaining findings.
