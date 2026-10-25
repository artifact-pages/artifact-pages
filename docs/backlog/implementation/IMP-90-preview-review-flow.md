# IMP-90 — Focus preview review and explicit published-page navigation

- Status: Done
- Assignee: Claude
- Scope: UI/UX S8

## Accepted outcome

Changed pages visible, affected pages collapsed with count and shared resources deduplicated. Preview tag menu reaches group pages and confirmed same-path published document, distinguishes absent/loading/unavailable, keeps site home separate. Trust/revision/cache/error behavior unchanged; no TOC/schema expansion.

## Verification

Run on the worktree: `npm run build` passed; `npm run test:web-unit` passed 153/153 with an English locale (under a Japanese system locale one unrelated locale-dependent test, `site-folder-counts`, fails on "7ページ" vs "7 pages"); `npm run build-storybook` passed; `npm run test:e2e` passed 359/359. No release/deploy.

A fresh Sonnet review found the Preview menu overflowing left at 390 px, disabled menu items unreachable by keyboard and not announced, and the lost full-revision tooltip on the Preview tag. The follow-up change fixes them: the menu is left-aligned, disabled items use `aria-disabled` and stay in arrow navigation, the trigger carries a `title` with the full revision, and the affected-pages disclosure keeps an `h3` inside its summary. New E2E checks cover each.
