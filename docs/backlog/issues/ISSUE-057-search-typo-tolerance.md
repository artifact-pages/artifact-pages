# 2文字の入れ替えのような打ち間違いで文書が見つからない

- Status: Won't fix
- Priority: P3
- Area: Command palette search

## Problem

パレットの検索で、`reading` を `raeding` のように2文字入れ替えて打つと、候補が1件も出ない。タイトルを正確に覚えていない、または打ち間違えた利用者は、文書を見つけられない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide/en/reading.html` で ⌘K を押し、`raeding` と入力する。
2. 「Nothing matches. Try > for commands, @ for sites, or # for headings.」と表示され、Reading（`en/reading.html`）は候補に出ない。
3. `read` と入力すると、Reading と「読者の体験」が候補に出る。

どこまでの打ち間違いを許すべきかは決まっていない。許しすぎると関係のない候補が増えるおそれがある。

## Expected outcome

よくある小さな打ち間違いがあっても、目的の文書を見つけられる。打ち間違いを許す範囲は、関係のない候補を増やしすぎない程度にとどまる。

## Acceptance criteria

- [ ] 隣り合う2文字の入れ替えなど、決めた範囲の打ち間違いで目的の文書が候補に出る。
- [ ] 正確な入力のときの候補の順番は、これまでより悪くならない。
- [ ] 打ち間違いを許す範囲を、仕様または issue 内に記録する。

## Related issues and scope

- 許す範囲は製品の判断が必要なため、実装前に案を比較して決める。

## Decision (2026-10-01)

Won't fix. The owner decided to keep the current fuzzy search, which matches characters in order: a query is found when its characters appear in the same order in the title or path, so swapped letters such as `raeding` do not match `reading`. Order-sensitive matching keeps unrelated results out of the list, and the empty-result guidance (ISSUE-042) already tells readers how to continue. Revisit only if real usage shows readers commonly fail on transposed or mistyped queries.
