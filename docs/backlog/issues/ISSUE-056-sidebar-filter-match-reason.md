# サイドバーの絞り込みで、ファイル名だけが一致した候補の理由が見えない

- Status: Open
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

- [ ] ファイル名だけが一致した候補でも、一致した理由が分かる（ファイル名の表示や強調など）。
- [ ] タイトルが一致した候補の表示は、これまでどおり分かりやすい。
- [ ] 狭い幅のサイドバーでも、候補の表示が崩れない。
