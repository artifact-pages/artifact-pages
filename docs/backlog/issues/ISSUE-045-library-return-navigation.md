# サイト内からライブラリへ戻る導線が見つけにくい

- Status: Done
- Priority: P2
- Area: Site navigation / Library return

## Problem

サイト内から全サイトの一覧へ戻る入口を発見できない。Guide home はサイトホームへ戻り、サイト切替はサイト候補のパレットを開く。直リンクで文書を開いた利用者はブラウザの戻る履歴にも頼れない。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザ、Guide 1サイトで確認。

1. `http://127.0.0.1:4179/guide/ja/reading.html` のヘッダーとサイト切替を調べる。
2. Guide home は `/guide` へ移動する。
3. サイト切替の `@` パレットには Guide があり、`/` のライブラリへの項目は見当たらなかった。
4. `/guide` のサイトホームでもライブラリへの明示的な入口を発見できなかった。

別サイトがある場合は未検証。全実装に入口がないと断定せず、観測した画面での発見性を扱う。

## Expected outcome

サイトや文書の直リンクからでも、ブラウザ履歴を使わずにライブラリのサイト一覧へ戻れる。

## Acceptance criteria

- [x] サイトホームと文書閲覧画面から、ライブラリへ戻る操作を発見して実行できる。
- [x] サイトホームへの移動と全サイト一覧への移動の違いが分かる。
- [x] サイドバーを閉じた状態・390px幅でも同じ移動先へ辿れる。

## Verification

2026-10-01: npm run build, focused library-return regression, and git diff --check passed. The regression verifies site-home and artifact deep-link return to / at 390px with navigation closed. Codex in-app browser at port 4179 verified Guide document and site-home controls reach Choose a site; owned temporary tab closed. A separate gpt-6-luna max reviewer independently ran the new case plus root-catalog, single-site @ Enter, multi-site switcher, and current-page pin cases, and a one-off 390px Tab/Enter library return check; all passed, no material findings. Desktop labels distinguish All sites from site home; narrow controls retain explicit accessible names.
