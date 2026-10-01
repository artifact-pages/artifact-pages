# サイト一覧のパレットに、その画面では使えない「# headings」の案内が出る

- Status: Done
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

- [x] サイト一覧の画面では、使えない「# headings」の案内が表示されない（または使えない理由が分かる）。
- [x] 文書を開いている画面では、これまでどおり見出し検索の案内が表示される。

## Related issues and scope

- ISSUE-042（完了記録は Git 履歴に保存）はゼロ件時の案内を扱った。本件は通常時の下部の案内を扱う。

## Verification (2026-10-01)

- Implemented by a Sonnet subagent and reviewed by a separate Sonnet subagent (no blockers; test follow-ups applied).
- The palette footer renders "# headings" only while an artifact is open, so it is hidden on the library and the site home, where typing `#` answers "Open an artifact first to search its headings." The navigate, open, "> commands", and "@ sites" hints stay because they work in those contexts. With an artifact open the footer is unchanged.
- New e2e test "the palette footer advertises headings only when an artifact is open" covers the library (including the `#` message), a site home, and an open artifact. The review also found a readiness race in ISSUE-055's palette pin test (Control+K pressed before the workspace listened); it now waits for the page and asserts the palette opened before typing, with text-filtered toast assertions.
- `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 92/92, and a second run had only the known-flaky "preview HTML uses the actual app origin…" failure.
