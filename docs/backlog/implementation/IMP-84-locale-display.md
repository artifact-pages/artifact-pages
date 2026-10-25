# IMP-84 — Browser-localized dates and counts

- Status: Done
- Assignee: Codex
- Scope: Web UI/UX slice S2

## Goal

Show reader dates and numbers using the browser's preferred language. Count nouns support Japanese and English, with English nouns for other languages. Keep English operation labels and published artifact content unchanged.

## Acceptance criteria

- [x] Dates and counts on discovery, folders, site home, Details, search and previews use shared locale-aware display helpers.
- [x] Japanese and English count nouns, zero/singular/plural, large numbers, other-language fallback and malformed locale/date inputs are verified.
- [x] Preview timestamps retain named local zones, machine-readable instants and precise UTC tooltips.
- [x] English regressions and Japanese browser flows pass; no header, schema, search ranking or artifact-body changes.

## Verification

Stacked on S1 branch `codex-uiux-s1-focus` (4046e0a0); worktree `codex-uiux-s2-locale`. Owner requested continuation on 2026-10-25. Verification on Node 24.18.0:

- `npm run build`: pass.
- `npm run test:web-unit`: 276/276 pass, including Japanese/English count grammar, other-language number formatting with English unit fallback, invalid locale/date handling and invariant preview UTC metadata.
- `npm run build-storybook`: pass.
- Full local nginx/Chromium E2E: 343/343 pass with the final source (341 existing regressions plus two Japanese locale flows). The English suite explicitly uses en-US.
- Manual browser inspection under Japanese preferences confirms localized site/folder counts and update dates; the HTML artifact's original English date is preserved.
- `git diff --check`: pass.

The palette-order regression now waits for asynchronous search metadata before asserting its sections. The new locale tests register the generated search fixture and scope timestamp assertions to the preview group, excluding the sidebar's separate index-generation date.

Fresh independent Sonnet medium cross review on 2026-10-25 found no actionable defects in product commit 7da43190 (combined S1/S2 review). All 8 CI checks passed in run 40152744108. Cosmetic mixed-language count phrases preserve the accepted English surrounding UI copy and Japanese count nouns; no product change was requested by the reviewer. No merge, release or deployment.
