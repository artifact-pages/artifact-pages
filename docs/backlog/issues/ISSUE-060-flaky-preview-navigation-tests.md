# プレビュー関係の画面遷移の e2e テストが、並列実行で失敗したり通ったりする

- Status: Done
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

- [x] 失敗の原因を特定し、テストのタイミングの問題か製品の不具合かを記録する。
- [x] 原因に合わせて、テストまたは製品を直す。待ち時間を延ばすだけ、または再試行に頼るだけの対処は避ける。
- [x] `node scripts/run-e2e.mjs` を少なくとも10回続けて実行し、プレビュー関係のテストが1回も失敗しない。
- [x] ほかのテストの結果を悪くしない。

## Related issues and scope

- 以前の記録（ISSUE-037 の検証メモ）にも、プレビュー関係のテストが再実行で通ったという記述がある。
- ISSUE-059（未登録のプレビュー URL の扱い）とは別の問題として扱う。

## Verification (2026-10-01)

- Investigated and fixed by a Sonnet subagent and reviewed by a separate Sonnet subagent (no blockers).
- Root cause: test timing. The reader injects `/preview-bridge.js` into the preview iframe only after the iframe `load` event, a HEAD fetch, and the script fetch; the bridge registers its capture-phase click listener when the script executes. The tests clicked in-frame links as soon as the iframe (or the `<script data-preview-reader-bridge>` element) existed, so an early click navigated natively inside the iframe and the top-level URL never changed. Trace: expected `.../guides/preview-target.html?group=pr%3A42&source=fixture#changed-target`, received unchanged `.../guides/preview.html?group=pr%3A42`.
- Fix: `PreviewDocumentPage.tsx` marks the injected script `data-preview-reader-bridge="ready"` from its `load` handler (after it executes). The e2e helper `waitForPreviewBridge(page)` waits for that marker before every in-frame link click in the preview HTML tests (12 clicks, including the fragments test). No timeouts were raised and no retries added. Existing presence-only selectors on `[data-preview-reader-bridge]` still match.
- Stability: `-g "preview HTML" --repeat-each 20 --workers 8` passed 600/600 after the final edit; `node scripts/run-e2e.mjs` passed 92/92 in 10 consecutive runs.
- This fixes the test race only. The same short window still exists for a real reader clicking right after load; it is tracked separately as [ISSUE-061](ISSUE-061-early-preview-click-escapes-reader.md).
