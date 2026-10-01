# パンくずのフォルダと文書のメニューが同じ内容に見える

- Status: Done
- Priority: P3
- Area: Artifact header breadcrumb

## Problem

文書を開いたときの上部のパンくず「en ⌄ / Reading ⌄」で、どちらのメニューも同じフォルダの文書一覧と「Show in sidebar」を表示する。2つのメニューの違いが分からず、どちらを使えばよいか判断できない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開く。
2. 「en ⌄」を押す。見出し `en`（2 artifacts）の下に Reading（Current）と What is Git Artifact Pages?、「Show in sidebar」が出る。
3. Esc で閉じ、「Reading ⌄」を押す。見出しが `en/reading.html` になるだけで、同じ2件と「Show in sidebar」が出る。

未確認の観測：手順3で、Esc で閉じた直後の最初のクリックではメニューが開かず、2回目のクリックで開いた。1回だけの観測で、再現条件は確かめていない。

## Expected outcome

フォルダのメニューと文書のメニューが、それぞれ何をするためのものかが分かる。必要がなければ、片方にまとまっている。

## Acceptance criteria

- [x] フォルダ部分と文書部分のメニューの役割の違いが、表示内容から分かる（または1つにまとまっている）。
- [x] 一方のメニューを Esc で閉じた直後でも、もう一方を1回のクリックで開ける。
- [x] キーボードでも、同じメニューを開いて項目を選べる。

## Verification (2026-10-01)

- Implemented by a Sonnet subagent and reviewed by a separate Sonnet subagent (no blockers; the root-level, focus, cursor, and test follow-ups were applied).
- Cause: each folder segment's menu listed every artifact under that folder (recursively), and the current-document menu listed the artifacts in the same directory, so in a flat folder both showed the same list.
- The current-document dropdown was removed; the current segment is a non-interactive `<span class="breadcrumb-current" aria-current="page">` (`tabIndex={-1}` as a focus fallback, `cursor: default`). Folder segments keep menus named "Browse artifacts in <path>". A root-level artifact gets a leading site-root trigger ("Browse artifacts in <site name>") that lists the site's top-level artifacts, so the header still offers its siblings.
- After choosing an item, focus returns to the opening trigger, or to the current-page label if that trigger no longer exists.
- The "first click after Escape" observation did not reproduce; a test now opens one menu, presses Escape, and opens another with a single click (and the reverse).
- e2e covers the new structure, nested and root-level menus (root-level via a route-modified index), keyboard opening and selection, cross-folder choice without focus loss, and the absence of a menu button on the current segment. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 87/87.
