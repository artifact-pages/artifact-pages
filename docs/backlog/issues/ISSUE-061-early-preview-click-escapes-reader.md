# プレビューの読み込み直後にリンクを押すと、リーダーの外で元ファイルが開く

- Status: Open
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

- [ ] 読み込み直後のクリックでも、リーダーのルートとサイドバーが目的の文書に合う（bridge を早く差し込む、またはリーダーが iframe の移動を検出して同期するなど）。
- [ ] 既存のプレビューの画面遷移のテストを壊さない。
- [ ] 早いクリックを再現する回帰テストを追加する。

## Related issues and scope

- ISSUE-060 は、テストがこの隙間に当たって不安定になる問題を、テスト側で bridge の準備を待つことで直した。本件は、利用者側に残る同じ隙間を扱う。
- 直し方の候補（レビューの提案）：iframe 自身の文書から bridge を読み込む、または `onLoad` で iframe が別の `/files/*.html|md` に移ったことを検出し、既存のメッセージ処理で同期する。どちらも読み込みの流れを変えるため、意図して独立に扱う。
