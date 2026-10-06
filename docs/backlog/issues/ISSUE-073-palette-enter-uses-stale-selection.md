# Pressing Enter right after typing in the command palette can do nothing or open the wrong page

- Status: Done
- Priority: P2
- Area: Command palette selection (`web/src/components/CommandPalette.tsx`)

## Problem

Regression from PR #34 (ISSUE-048). The palette reset `selectedIndex` in a `useEffect` after the render for a new query or new entries, so for one render the new `entries` were paired with the old `selectedIndex`. `handleKeyDown` reads that pair on Enter. Before #34 the default was almost always 0, so the stale value happened to be correct. Since #34, `defaultSelectionIndex` can return -1 or a value above 0 in the blank state (the open page is skipped). A fast type-then-Enter therefore does nothing (`entries[-1]`) or opens the wrong row.

## Evidence and reproduction

Confirmed by code reading: `selectedIndex` was set by two reset effects (`[query, context, currentIndex, sites.length]` and the entry sequence), and `handleKeyDown` read `entries[selectedIndex]` without regard to which render produced the pair.

Observed as intermittent e2e failures in `web/e2e/local-serving.spec.ts` under parallel load:

1. "results group by folder, open from the keyboard, and persist through navigation and history": Enter right after `fill('Platform topology')` opened a different page.
2. "the collapsed rail searches artifacts and switches sites": the palette stayed open after `fill('>Use system theme')` plus Enter.

Reproduction on unfixed code (origin/main aef55718) with the new regression test (pinned current page only, so the blank default is -1; `fill` then `press('Enter')` with no waits): 0 failures in 50 runs at `--workers=8` and 0 in 200 runs at `--workers=12`. The race did not reproduce in this test, so it does not demonstrate the failure on its own; React usually flushes pending passive effects before the next discrete event. The two flaky tests above remain the natural coverage and were left without added waits.

Not decided: the exact timing under which the effect had not yet run when Enter arrived.

## Expected outcome

Enter always acts on the selection that belongs to the query and entries on screen. On open the selection is the default; a typed query selects the default for that query; the `@` and blank rules from ISSUE-048 are unchanged.

## Acceptance criteria

- [x] The selection is derived during render from a key (context, site, query, entry sequence where the list drives the default) and a stored index; no reset effects remain (`resolveSelectedIndex` in `web/src/domain/palette-sections.ts`).
- [x] Unit tests cover a stored selection from another key, beyond the entries, and within the entries (`npm run test:palette-sections`: 12 passed).
- [x] e2e regression test "typing then pressing Enter at once opens the first match even when the blank default is not the first row" added.
- [x] `npx tsc -b web/tsconfig.json` and `npm run build` pass.
- [x] With `--workers=8`, "results group by folder, open from the keyboard", "collapsed rail searches artifacts and switches sites" and the new test, `--repeat-each=100`: 300 passed, 0 failed.
- [x] Full suite `CI=1 npm run test:e2e`: 158 passed, 0 failed, no flaky test reported.
