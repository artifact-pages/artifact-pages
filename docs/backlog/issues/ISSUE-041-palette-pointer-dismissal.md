# パレットに分かりやすいクリック・タップ用の閉じる操作がない

- Status: Done
- Priority: P2
- Area: Command palette / Narrow screen

## Problem

パレット右上の `esc` は押せそうに見えるがクリックしても閉じない。キーボードを使わない利用者は、背景クリックで閉じることを探す必要がある。狭い画面でも明示的な閉じるボタンが見当たらない。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザ、通常幅と390×844で確認。

1. `http://127.0.0.1:4179/guide/en/reading.html` で検索ボタンからパレットを開く。
2. 右上の `esc` 表示をクリックしても閉じない。
3. Escape キーまたは背景クリックでは閉じる。

実機のタッチ・ソフトウェアキーボードは未検証。ローカル補足証拠: `.local/ux-review-2026-10-01/mobile-palette.jpg`（未追跡）。

## Expected outcome

パレット内に見つけやすいポインター用の閉じる操作があり、キーボードなしでも閉じ方を予測できる。

## Acceptance criteria

- [x] 通常幅・390px幅で、パレット内の明示的な閉じる操作をクリックして閉じられる。
- [x] 閉じる操作にアクセシブルな名前があり、ショートカット表記と実行ボタンを取り違えない。
- [x] Escape と背景クリックによる閉じ方を維持し、閉じた後に操作を続けられる。

## Verification

2026-10-01: npm run build and scoped git diff --check passed. The focused pointer-close regression passed at 1280×800 and 390×844, exercising SitePicker close/focus return and workspace pointer, Escape, and backdrop dismissal/focus return. A separate gpt-6-luna max reviewer identified the missing root-palette focus return during review; it was fixed, the reviewer independently reran the regression at port 4174 (1 passed), and approved the final diff with no findings. Manual Codex in-app browser validation at port 4179 checked these controls at normal width and restored the original tab URL. Narrow-width validation was automated, not manual. Existing large-chunk build warning remains.
