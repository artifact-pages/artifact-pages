# パレットで文書を探す目的が見出し・コマンドの候補に埋もれる

- Status: Done
- Priority: P2
- Area: Command palette / Document discovery

## Problem

文書を探すために開いたパレットに、ページ・現在の文書の見出し・コマンドが同居する。初めて使う人は、どの種類の結果を選ぶと文書が開くのか、空欄でどこから探せばよいかを判断する必要がある。文書検索を主役にし、よく使う文書へすぐ戻れる体験へ改善する。

既存機能の故障とは断定しない。2026-10-01 の初心者レビューを受けた改善案のうち、利用者が選んだ「1: 文書検索を主役にする」を記録する。検索対象ボタンの追加や候補内の操作メニューは今回の対象ではない。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザ、Guide 1サイト・HTML 4文書で観測。

1. `http://127.0.0.1:4179/guide/ja/reading.html` を開き、⌘K でパレットを開く。
2. 空欄では Pages と Commands が同じ候補一覧に表示される。
3. 「キーボード」と入力すると現在の文書の見出しが結果に出る。普通の文字列入力でもページ以外の結果を検索する。
4. 最近読んだ文書とピン留め文書は Recent／Pinned で絞れるが、初回の空欄表示から用途別の探し始めを理解する必要がある。

追加の観測（2026-10-01、Claude in Chrome、初心者レビュー）：`/guide/en/reading.html` で ⌘K を押すと、空欄の状態で最初に選択されているのは閲覧中の文書（「Current page · Pinned · Read 1m ago」）だった。そのまま Enter を押しても画面は変わらず、最初の Enter が何にもつながらない。

現在の順位付けが常に不適切だとは断定しない。大量文書・複数サイトでの体験は未検証。改善後は通常幅と390px幅で、現実的なタイトル・ピン・閲覧履歴を使って判断する。

## Expected outcome

普通にパレットを開いて入力する操作を、まず文書を探して開く体験として理解できる。空欄では最近読んだ文書やピン留めを手がかりに探し始められ、文字を入れると文書の候補が主役になる。見出し移動やコマンドも、それぞれの種類と実行結果が分かる入口から利用できる。

## Acceptance criteria

- [x] 空欄のパレットから、最近読んだ文書・ピン留め文書を発見して開ける。履歴・ピンがない場合も探し始め方が明確。
- [x] 普通の文字列で文書を探したとき、文書候補が主役になり、見出し・コマンドの結果と取り違えない。
- [x] 現在の文書を表示する場合は閲覧中だと分かる。
- [x] 見出し検索・コマンド実行・サイト切替の機能を維持し、普通の検索はアクティブサイト内に留まる。
- [x] 通常幅と390px幅で、候補の種類と選択対象が分かり、キーボードとポインターで文書を開ける。

## Related issues and scope

- ISSUE-038（完了記録は Git 履歴に保存） は件数・現在の文書の省略の整合性を修正する。本件は文書発見の初期体験と候補の優先度を扱い、その修正をやり直さない。
- ISSUE-039（完了記録は Git 履歴に保存） は検索入口の役割と Enter 操作の整合性を扱う。本件はパレット内の候補の見せ方を扱う。
- ISSUE-042（完了記録は Git 履歴に保存） のゼロ件回復案を重複実装しない。
- 文書検索を主役にする方向のみ選択済み。具体的な候補グループ・順位・コマンド入口の見せ方は、実装前に比較できる案として確認する。完了済み ISSUE-038–047 の修正とは独立して扱う。

## Verification (2026-10-07)

- Implemented in PR #34. The palette's blank state lists Pinned, then Recently read, then a hint (no Commands section); the open page is marked "Current page" (dot, `aria-current="page"`) and is never preselected, so the first Enter opens the most recent other page; the selected row shows a fill and an Enter hint; a typed plain query lists Pages (and Page text) with headings and commands only when no page matches. Prefix modes (`#`, `>`, `@`) and site-scoped search are unchanged. Accepted behavior is in `docs/specification.md`.
- The owner verified the palette in Storybook on 2026-10-07 at normal width, at 390px and with long titles.
- Unit tests (`npm run test:palette-sections`, 9 cases) cover selection, section building, the empty-history flag, the typed fallback, the current-page flag and arrow-key movement. New e2e cases in `web/e2e/local-serving.spec.ts`: "blank palette: first Enter opens the most recent other page, not the current one", "blank palette marks the current page and does not select it", "blank palette with a pinned current page keeps it once under Pinned, unselected, and selects the next page", "blank palette with no history shows guidance and ranked pages", "blank palette lists no Commands section and hints at > # @", "typing a page name lists only Pages (and Page text), not headings or commands", "typing text that matches no page falls back to labeled Headings and Commands groups", "prefix modes still reach headings, commands, and sites", "plain search stays in the active site" and the two 390px "palette at 390px" cases. `CI=1 npm run test:e2e` passed 157/157.
