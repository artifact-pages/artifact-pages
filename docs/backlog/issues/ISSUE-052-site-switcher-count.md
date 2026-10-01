# サイト切替の横の数字が何の数か分からない

- Status: Done
- Priority: P3
- Area: Sidebar site switcher

## Problem

サイドバー上部のサイト名の横に「1 ⌄」と表示される。押すと `@` 入りのパレットが開き、サイトの一覧が出ることから、数字はサイト数のようだが、ラベルもツールチップもないため、初めての利用者には意味が分からない。

## Evidence and reproduction

2026-10-01、Claude in Chrome で操作。ビューポート約1568×568（ウィンドウ最大化のため幅の変更は不可）、Guide 1サイト・HTML 4文書、ダークテーマ（System）。コードとドキュメントを読まずに操作した初心者レビュー。

1. `http://127.0.0.1:4179/guide` を開く。サイドバー上部に「Guide　1 ⌄」と表示される。
2. 「1 ⌄」にマウスを乗せる。説明は表示されない。
3. 押すと `@` が入ったパレットが開き、サイト一覧（Guide のみ）が表示される。

## Expected outcome

数字が何を表すのか、押すと何が起きるのかを、操作する前に理解できる。

## Acceptance criteria

- [x] 数字の意味（利用できるサイトの数など）が、表示またはツールチップで分かる。
- [x] 押したときにサイトを切り替える操作が開くことが、操作前に予測できる。
- [x] スクリーンリーダー向けの名前でも、同じ意味が伝わる。

## Verification (2026-10-01)

- Implemented by a Sonnet subagent and reviewed by a separate Sonnet subagent (no blockers; the rail tooltip, shared count helper, count source, and test follow-ups were applied).
- The visible switcher still shows the site name, count, and chevron; the count is `aria-hidden` and explained by the tooltip "Switch site — N sites available" (singular "1 site available") and the accessible name "Switch site. Current site: <Name>. N sites available". The collapsed-rail button's tooltip also names the site: "Switch site — <Name> (N sites available)".
- The count comes from the same site list the palette shows after clicking, built by `siteCountLabel` in `web/src/domain/site-count-label.ts`.
- New e2e test "site switcher names its count in the tooltip and accessible name" covers multi-site fixtures, a route-mocked single site, and the collapsed rail. `npx tsc -p web/tsconfig.json --noEmit` and `npm run build` passed; `node scripts/run-e2e.mjs` passed 85/85 (earlier runs had only the known-flaky preview-navigation tests fail).
