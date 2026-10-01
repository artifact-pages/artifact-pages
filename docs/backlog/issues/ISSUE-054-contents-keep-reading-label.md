# 目次パネルの「Keep reading」の意味が分からない

- Status: Done
- Priority: P3
- Area: Contents / Details panel

## Problem

Contents と Details のパネルの右上にある「Keep reading」が、何をするボタンなのかを名前から読み取れない。また、Contents で見出しを選ぶとパネルが閉じるため、続けて別の見出しへ移りたいときは、もう一度パネルを開く必要がある。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開き、上部の Contents を押す。パネルの右上に「Keep reading」が表示される。
2. 目次の項目（例：Keyboard shortcuts）を押す。パネルが閉じ、文書がその見出しへ移動する。
3. Details を開いた場合も、右上に同じ「Keep reading」が表示される。

## Expected outcome

パネルを閉じて読み続ける操作だと、ボタンの名前や見た目から分かる。目次を選んだあとにパネルが閉じることが予測できる、または続けて使える。

## Acceptance criteria

- [x] 「Keep reading」に当たる操作の役割が、名前または見た目から分かる。
- [x] 目次の項目を選んだあとのパネルの動き（閉じる・開いたまま）が、利用者の予測と合う。
- [x] 通常幅と狭い幅で、本文が読める状態へ戻れる。

## Related issues and scope

- ISSUE-047（完了記録は Git 履歴に保存）で、パネルを開いたまま読むと本文が隠れる問題に対して、読み続ける操作を追加した。本件はその操作の名前の分かりにくさを扱う。

## Verification (2026-10-01)

- Implemented by a Sonnet subagent and reviewed in two rounds by separate Sonnet subagents (no blockers; the occlusion criterion, stale-poll cancellation, `aria-current` clearing, focus, and test-timing follow-ups were applied).
- "Keep reading" is replaced by an × close button like the palette's, named and tooltipped "Close Contents" / "Close Details". Escape still closes; closing returns focus to the toggle that opened the panel.
- After choosing a heading in Contents, the panel stays open only when the heading would remain visible, preserving ISSUE-047's goal:
  - HTML artifacts: the panel closes right after navigating (their headings land under the panel in practice) and focus moves to the Contents toggle.
  - Markdown artifacts: once the heading's position settles, its text box is compared with the panel; if they intersect (or the heading cannot be measured), the panel closes and focus moves to the Contents toggle; otherwise it stays open and the chosen entry gets `aria-current="location"`.
  - Palette `#` jumps still close the palette and panel.
- A pending check is cancelled when the panel closes or changes or the artifact changes, so it cannot close a newly opened panel.
- e2e covers the close control, HTML closing with focus on the toggle, Markdown kept open at 1280px without overlap, 390px closing, geometry at 800–1000px with and without the sidebar, and the close-and-reopen race. Waits use a `data-heading-jump` settled signal. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 89/89 (one earlier run had a known-flaky preview-navigation failure).
