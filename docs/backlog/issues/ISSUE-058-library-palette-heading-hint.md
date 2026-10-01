# サイト一覧のパレットに、その画面では使えない「# headings」の案内が出る

- Status: Open
- Priority: P3
- Area: Library (site list) palette

## Problem

サイト一覧の画面（`/`）でパレットを開くと、下部の案内に「# headings」が表示される。この画面では文書を開いていないため、見出しを検索できる場面ではなく、案内と実際にできることが合わない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/` を開き、⌘K を押す。
2. パレットにはサイトの一覧（Guide）とテーマのコマンドが表示され、下部に「↑ ↓ or Ctrl+J/K navigate」「↵ open」「> commands」「@ sites」「# headings」と表示される。
3. この画面には見出しを検索できる文書がない。

## Expected outcome

パレット下部の案内に、今の画面で使える操作だけが表示される。

## Acceptance criteria

- [ ] サイト一覧の画面では、使えない「# headings」の案内が表示されない（または使えない理由が分かる）。
- [ ] 文書を開いている画面では、これまでどおり見出し検索の案内が表示される。

## Related issues and scope

- ISSUE-042（完了記録は Git 履歴に保存）はゼロ件時の案内を扱った。本件は通常時の下部の案内を扱う。
