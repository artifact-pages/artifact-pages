# サイドバーの絞り込みで、ファイル名だけが一致した候補の理由が見えない

- Status: Done
- Priority: P3
- Area: Sidebar filter

## Problem

サイドバーの「Filter navigation」で絞り込むと、タイトルではなくファイル名（パス）だけが一致した文書も候補に出る。しかし、サイドバーにはタイトルしか表示されないため、なぜその文書が出てきたのか分からない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` を開き、サイドバーの「Filter navigation」に `what` と入力する。
2. `en` の下に「What is Git Artifact Pages?」（タイトルの What が強調される）、`ja` の下に「Git Artifact Pagesとは」が表示される。
3. 「Git Artifact Pagesとは」は、ファイル名 `ja/what-is-git-artifact-pages.html` が一致して表示されているが、ファイル名は表示されず、強調もない。

## Expected outcome

絞り込みの候補ごとに、どこが一致したのか（タイトルかファイル名か）が分かる。

## Acceptance criteria

- [x] ファイル名だけが一致した候補でも、一致した理由が分かる（ファイル名の表示や強調など）。
- [x] タイトルが一致した候補の表示は、これまでどおり分かりやすい。
- [x] 狭い幅のサイドバーでも、候補の表示が崩れない。

## Verification (2026-10-01)

- Implemented by a Sonnet subagent and reviewed by a separate Sonnet subagent (no blockers; the deterministic narrow-width test, per-field matching, and accessibility follow-ups were applied).
- In the sidebar Matches list, a result whose title does not contain the query shows a small monospaced line (existing `.tree-path` style) with the matching path, or the filename if only it matches, and the match in `<mark>`. Long paths start shortly before the match with a leading "…" so the match stays visible. The line is `aria-hidden` because the row already exposes the full path. Title matches look as before.
- The sidebar filter now tests title, path, and filename separately instead of a joined string, so every listed result has either a title highlight or a reason line (a query can no longer match across a field boundary).
- e2e covers a path-only match with a highlighted reason line, a title match without one, and at 1280px and 390px (with the mobile sidebar opened deterministically) no horizontal overflow and the highlighted match within the sidebar. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 91/91.
