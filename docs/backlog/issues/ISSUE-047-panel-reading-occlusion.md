# 目次・詳細を開いたまま読むと本文が隠れる

- Status: Done
- Priority: P3
- Area: Contents / Details overlays

## Problem

右側のパネルが本文に重なり、パネルを参照しながら文章を読む用途で内容が隠れる。390px幅では本文の大部分に重なる。重ねて表示すること自体を実装不具合とは断定せず、閲覧中の可読性の改善を扱う。

## Evidence and reproduction

2026-10-01、Codex アプリ内ブラウザで確認。

1. `http://127.0.0.1:4179/guide/ja/reading.html` の冒頭で Contents または Details を開く。
2. 通常幅でも右側の説明文にパネルが重なる。
3. 390×844 で Contents を開くと、本文の大部分に重なる。
4. 目次を選ぶと目的の見出しへ移り、パネルは閉じ、URLのハッシュも更新される。この移動動作は正常だった。

## Expected outcome

パネルの情報を参照する際も本文の読解を続けやすく、隠れた箇所へ戻る操作が分かる。レイアウト方式の変更はこの issue で確定しない。

## Acceptance criteria

- [x] 通常幅・390px幅で、パネルに隠れる本文を読むための明確な操作または表示方法がある。
- [x] パネルを退ける操作や表示変更で読んでいた位置を失わない。
- [x] 目次選択による見出し移動・ハッシュ反映・閉じる動作と、詳細参照を維持する。

## Verification

The optional Contents/Details panel now has a visible Keep reading dismissal button. Overlay layout and iframe width are preserved. Build and two focused Playwright cases passed; independent review_issue_047 found no blocking findings, independently passed two focused cases and the complete 77/77 e2e suite. Normal 1280x800 and narrow 390x844 verification covered pointer dismissal, panel reopening, preserved reader scroll, Contents heading jump/hash/autoclose, and keyboard Enter/Space dismissal with visible focus. Existing Details metadata/link coverage passed in the full suite. Manual in-app browser visual follow-up was unavailable; these follow-up checks used repository headless Playwright.
