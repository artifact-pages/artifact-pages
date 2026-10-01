# プレビュー0件を入口で判断できず、空画面への移動が必要になる

- Status: Done
- Priority: P3
- Area: Site home / Preview discovery

## Problem

サイトホームの View previews から移動して初めてプレビューが0件だと分かる。専用画面では普段のサイドバーとツールバーも消えるため、成果のない画面移動と復帰操作が増える。戻る導線の故障ではなく、空状態への入口の改善。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザで確認。

1. `http://127.0.0.1:4179/guide` の View previews を押す。
2. `/guide/_previews` に移り、「There are no available previews for this site.」が表示される。
3. サイドバー・ツールバーは消え、戻るリンクで `/guide` へ戻れる。
4. パレットの Previews も0件だった。

実データ入りプレビューは未検証。

## Expected outcome

プレビューがないときに不要な移動を避けられ、プレビューの対象と利用可能性を入口で判断できる。

## Acceptance criteria

- [x] ホームのプレビュー入口で、現在0件であることを判断できる。
- [x] 0件でも何を待つ・確認する画面なのか分かり、サイトホームへの復帰手段が明確。
- [x] プレビューが存在する場合は一覧へ進む導線を維持する。

## Verification

Site home now checks validated preview candidates and reports zero, listed count, loading or availability-check failure. Empty preview list explains previews and publishing checks, with an explicit site-home return link; nonempty navigation remains intact. Build and seven focused Playwright cases passed against fixture 4174. Independent review_issue_046 found no blocking correctness issue and independently passed four focused cases, including missing/error distinction and loading return. Manual in-app browser follow-up remains unavailable. Known tradeoff: home checks catalog plus revision manifests, and list navigation currently repeats those uncached requests; malformed manifest warnings remain on the list while home reports available count.
