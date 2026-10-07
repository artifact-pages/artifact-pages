# プレビューの読み込み直後にリンクを押すと、リーダーの外で元ファイルが開く

- Status: Done
- Priority: P3
- Area: Preview reader / Preview HTML navigation

## Problem

プレビューの HTML 文書を開いた直後に文書内のリンクを押すと、リーダーのルートが更新されず、iframe の中で元ファイル（`/_previews/.../files/...`）がそのまま開くことがある。リーダーのサイドバーや URL の同期から外れ、読者はどこを見ているのか分かりにくくなる。再読み込みかブラウザの「戻る」で元に戻れる。

## Evidence and reproduction

ISSUE-060 の調査（2026-10-01）で、e2e テストの失敗の原因として確認した。

1. `PreviewDocumentPage.tsx` は、iframe の `load` イベントのあと、HEAD リクエストとスクリプトの取得を経て、iframe に `/preview-bridge.js` を差し込む。
2. `preview-bridge.js` は、実行時にクリックを捕まえるリスナーを登録する。差し込みから実行までの数百ミリ秒の間は、リスナーがない。
3. その間に文書内のリンクを押すと、リンクは iframe の中でそのまま移動し、リーダーの URL は変わらない（e2e のトレースでは、期待した `.../preview-target.html?group=pr%3A42&source=fixture#changed-target` に対して、URL は `.../preview.html?group=pr%3A42` のままだった）。

実際の利用で起きる頻度は低いと見ている。読み込み直後のごく短い時間に限られるため。

## Expected outcome

プレビューを開いた直後にリンクを押しても、リーダーの中で目的の文書へ移動する。

## Acceptance criteria

- [x] 読み込み直後のクリックでも、リーダーのルートとサイドバーが目的の文書に合う（bridge を早く差し込む、またはリーダーが iframe の移動を検出して同期するなど）。
- [x] 既存のプレビューの画面遷移のテストを壊さない。
- [x] 早いクリックを再現する回帰テストを追加する。

## Related issues and scope

- ISSUE-060 は、テストがこの隙間に当たって不安定になる問題を、テスト側で bridge の準備を待つことで直した。本件は、利用者側に残る同じ隙間を扱う。
- 直し方の候補（レビューの提案）：iframe 自身の文書から bridge を読み込む、または `onLoad` で iframe が別の `/files/*.html|md` に移ったことを検出し、既存のメッセージ処理で同期する。どちらも読み込みの流れを変えるため、意図して独立に扱う。

## Verification (2026-10-07)

- 方針: iframe の `onLoad` で、フレームが別の raw ファイルへ移ったことを検出し、bridge のメッセージ処理と同じ変換（`resolveLogicalDocumentLink`）でリーダーのルートに直して `navigate`（履歴は push）する。検索クエリ（`group` は除く）とハッシュは保つ。目的が `/files/*.html|md` の文書でない場合（画像、PDF、外部リンクなど）は変換できないので、従来どおり iframe 内の通常遷移のままになる。配信する raw ファイルは書き換えない（ISSUE-069 の byte 一致を保つ）。
- 履歴: 早いクリックでは iframe 自身の遷移がブラウザの履歴に1件入る（リーダーの URL は元のまま）。そのまま push すると「戻る」で何も変わらない1手が残るため、履歴が伸びていたら先に `history.go(-1)` で iframe を元の文書へ戻し、読み込み完了後に push する。これで「戻る」1回が元の文書、2回目がプレビューを開く前になり、bridge 経由の遷移と同じ。`replaceState` で置き換える案は、元の文書の履歴まで同じ URL になり戻れなくなるため採らなかった（実測）。
- 変更: `web/src/components/PreviewDocumentPage.tsx`。回帰テスト `preview HTML link clicked before the reader bridge runs still navigates the reader`（`web/e2e/local-serving.spec.ts`）は `/preview-bridge.js` を保留したままリンクを押し、URL、見出し、パス表示、iframe の中身と、戻る・進むの履歴（戻る1回で元の文書、もう1回で直前のページ）を確かめる。

| 確認 | 結果 |
| --- | --- |
| 修正なしで新テスト | 失敗（URL が変わらない） |
| 修正ありで新テスト（戻る・進むを含む）`--repeat-each=100 --workers=8` | 100/100 通過 |
| プレビュー関連 29 件 `--repeat-each=30 --workers=8` | 870/870 通過 |
| e2e 全体 161 件（subset recipe、`--workers=8`） | 161/161 通過 |
| `npm run build`（`tsc -b` を含む） | 通過 |
