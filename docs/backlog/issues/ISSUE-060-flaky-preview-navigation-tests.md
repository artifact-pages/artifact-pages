# プレビュー関係の画面遷移の e2e テストが、並列実行で失敗したり通ったりする

- Status: Open
- Priority: P2
- Area: e2e tests / Preview HTML navigation

## Problem

`node scripts/run-e2e.mjs` を実行すると、プレビュー関係の画面遷移を確かめる e2e テストが、毎回のように1〜2件失敗し、再実行すると通る。失敗するテストは実行ごとに入れ替わる。そのため、ほかの変更を確かめるたびに再実行が必要になり、本当の回帰と不安定な失敗の見分けに手間がかかる。製品の不具合なのか、テストのタイミングの問題なのかは、まだ切り分けていない。

## Evidence and reproduction

2026-10-01、ISSUE-049〜058 の修正中に `node scripts/run-e2e.mjs`（Docker 上の nginx、ポート 4174、Playwright の並列実行）をおよそ20回実行して観測した。

1. `npm run build` のあと `node scripts/run-e2e.mjs` を実行する。
2. 半分ほどの実行で、次のテストのうち1〜2件が失敗する。
   - `preview HTML keeps changed-document navigation in the preview and unchanged documents in production`（`web/e2e/local-serving.spec.ts` の 3467 行付近）
   - `preview HTML uses the actual app origin and survives direct reload on a non-loopback-equivalent hostname`（3790 行付近）
   - `preview HTML raw resources use native frame navigation and preserve download, target, and modifier intent`（3718 行付近）
3. 失敗の内容は `Error: expect(page).toHaveURL(expected) failed` で、実行時間は 5〜6 秒（既定のタイムアウトに近い）。
4. 同じ内容で再実行すると通る。変更していないコードでも起きた。

確認済みの事実はここまでで、原因は推測にとどまる。可能性として、iframe 内での画面遷移の完了を待たずに URL を確かめている、並列実行の負荷で遷移が遅れる、プレビューのカタログ読み込みとの競合、などが考えられる。

## Expected outcome

e2e テストを並列で実行しても、プレビュー関係のテストが安定して通る。失敗したときは、本当の回帰だと判断できる。

## Acceptance criteria

- [ ] 失敗の原因を特定し、テストのタイミングの問題か製品の不具合かを記録する。
- [ ] 原因に合わせて、テストまたは製品を直す。待ち時間を延ばすだけ、または再試行に頼るだけの対処は避ける。
- [ ] `node scripts/run-e2e.mjs` を少なくとも10回続けて実行し、プレビュー関係のテストが1回も失敗しない。
- [ ] ほかのテストの結果を悪くしない。

## Related issues and scope

- 以前の記録（ISSUE-037 の検証メモ）にも、プレビュー関係のテストが再実行で通ったという記述がある。
- ISSUE-059（未登録のプレビュー URL の扱い）とは別の問題として扱う。
