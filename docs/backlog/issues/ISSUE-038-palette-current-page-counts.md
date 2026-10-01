# パレットの件数と現在の文書の省略が矛盾して見える

- Status: Done
- Priority: P2
- Area: Command palette / All・Recent・Pinned

## Problem

現在の文書をピン留めしても、Pinned の空欄検索ではその文書が出ない。件数は1のままで、文字を入力すると結果が現れるため、保存失敗や検索故障に見える。現在の文書を省くこと自体の是非ではなく、件数・一覧・空状態・検索後の関係を説明できないことが問題。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザで確認。Guide 1サイト、HTML 4文書のローカル環境。

1. `http://127.0.0.1:4179/guide/ja/reading.html` を開く。
2. サイドバーの文書行の `…` → Pin。⌘K → Pinned を選ぶ。
3. 入力が空だと「Pinned 1」なのに「No other pinned pages are available in this site.」と表示される。
4. 「読者」と入力すると、同じタブにピン留めした現在の文書が現れる。再読み込み後も再現した。

Recent も件数2に対して空欄では1件、All も4文書中3件だった。内部の原因は未調査。ローカル補足証拠は `.local/ux-review-2026-10-01/pinned-empty.jpg`（未追跡）。この issue の再現手順だけで確認できる。

## Expected outcome

ピン留めした文書を見つけ直せる。現在の文書を含める場合も省略する場合も、件数と一覧の関係、検索による変化が利用者に分かる。

## Acceptance criteria

- [x] 現在の文書だけをピン留めした状態で、保存失敗に見える件数と空状態の食い違いがない。
- [x] All・Recent・Pinned で現在の文書の扱いが明確で、空欄とタイトル検索の結果の差を理解できる。
- [x] 再読み込み後も同じ基準で件数・一覧・空状態が表示される。

## Verification

2026-10-01: `npm run build` and `git diff --check` passed. Two focused Playwright cases (current-page scope counts and persistent recent reads) passed 2/2 against the isolated fixture server at port 4174. The Guide-only server at port 4179 was checked in the Codex in-app browser for blank All/Recent/Pinned, title search, and reload; Pinned 1 matched its current-page result. Test pin state was restored. A separate gpt-6-luna max reviewer inspected the final implementation and exact-count regression and found no blocking issues; it did not repeat the browser check. Only the palette component and related browser regressions changed.
